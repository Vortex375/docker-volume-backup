/* Copyright 2020 Benjamin Schmitz
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Docker = require('dockerode');
import ora = require('ora');
import util = require('util');
import path = require('path');
import fs = require('fs-extra');
import Table from 'easy-table';
import minimist from 'minimist';

import { bgCyan, green, red, bold } from 'colors/safe';
import { assign, filter, map, zipWith, sum, join, drop } from 'lodash';
import { format } from 'date-fns';
import { WrappedStream } from './stream';

interface BackupOptions {
  outputDir?: string;
}

interface Target {
  name: string;
  path: string;
}

const IMAGE_NAME = 'alpine';
const BACKUP_MOUNT = '/docker-volume-backup';

const progress = ora();

async function dockerVolumeBackup(dockerOptions: Docker.DockerOptions = {}, backupOptions: BackupOptions = {}, containers: string[]) {
  try {
    progress.start(`${bgCyan('connect-to-docker')} connect to Docker daemon`);
    const docker = new Docker(dockerOptions);
    await docker.ping();
    progress.succeed('connected to Docker');

    const mounts = await Promise.all(map(containers, async (name) => {
      progress.start(`${bgCyan('get-mounts-from-container')} inspecting container ${name}`);
      const container = docker.getContainer(name);

      return getMountsFromContainer(container);
    }));
    const targets: { [name: string]: Target[] } = assign({}, ... zipWith(containers, mounts, (container, mount) => ({[container]: mount})));
    progress.succeed(`inspected ${containers.length} containers, found ${sum(map(targets, (target) => target.length))} volumes to backup`);

    const infoTable = new Table();
    for (const containerName of containers) {
      infoTable.newRow();
      infoTable.cell('Container', containerName);
      let first = true;
      for (const mount of targets[containerName]) {
        if ( ! first) {
          infoTable.cell('Container', '');
        }
        infoTable.cell('Volume', `${mount.name}:${mount.path}`);
        infoTable.newRow();
        first = false;
      }
    }
    progress.info('Backup Targets: \n\n' + infoTable.toString());

    pullImage(docker);

    for (const name of containers) {
      const container = docker.getContainer(name);
      const inspect = await container.inspect();
      if (inspect.State.Running) {
        progress.start(`${bgCyan('stop-container')} stopping container ${name}`);
        await container.stop();
        progress.succeed(`stopped container ${name}`);
      }
    }

    let returnCode = 0;
    for (const name of containers) {
      const backupContainer = await prepareContainer(docker, name, backupOptions.outputDir ?? '.');
      const backupPath = await prepareBackupPath(backupContainer, name);
      for (const target of targets[name]) {
        const exitCode = await backup(backupContainer, backupPath, target);
        const outputPath = path.join(backupOptions.outputDir ?? '', join(drop(backupPath.split(path.sep), 2), path.sep), `${target.name}.tar`);
        progress.succeed(`backed up ${name}:${target.name} to ${outputPath}`);
        if (exitCode > returnCode) {
          returnCode = exitCode;
        }
      }
      await closeContainer(backupContainer);
      progress.succeed(`backup of ${name} complete (${targets[name].length} Volumes)`);
    }

    for (const name of containers.slice().reverse()) {
      const container = docker.getContainer(name);
      progress.start(`${bgCyan('start-container')} starting container ${name}`);
      await container.start();
      progress.succeed(`started container ${name}`);
    }

    process.exitCode = returnCode;

  } catch (err) {
    progress.fail();
    console.error(err);
    process.exitCode = 2;
  }
}

async function dockerVolumeRestore(dockerOptions: Docker.DockerOptions = {}, containerName: string, backupPath: string) {
  try {
    progress.start(`${bgCyan('connect-to-docker')} connect to Docker daemon`);
    const docker = new Docker(dockerOptions);
    await docker.ping();
    progress.succeed('connected to Docker');

    progress.start(`${bgCyan('get-mounts-from-container')} inspecting container ${containerName}`);
    const container = docker.getContainer(containerName);
    const mounts = await getMountsFromContainer(container);

    // ✓ X
    const infoTable = new Table();
    const targets: Target[] = [];
    infoTable.newRow();
    infoTable.cell('Container', containerName);
    for (const mount of mounts) {
      const backupFile = path.join(backupPath, `${mount.name}.tar`);
      try {
        await fs.access(backupFile, fs.constants.R_OK);
        infoTable.cell('Volume', `${bold(green('✓'))} ${mount.name}:${mount.path}`);
        infoTable.cell('From', backupFile);
        targets.push(mount);
      } catch (err) {
        infoTable.cell('Volume', `${bold(red('❌'))} ${mount.name}:${mount.path}`);
        infoTable.cell('From', '(no backup file found)');
      }
      infoTable.newRow();
    }
    progress.info('Restore Targets: \n\n' + infoTable.toString());

    if (targets.length === 0) {
      progress.warn('nothing to restore');
      process.exitCode = 1;
      return;
    }

    pullImage(docker);

    const inspect = await container.inspect();
    if (inspect.State.Running) {
      progress.start(`${bgCyan('stop-container')} stopping container ${containerName}`);
      await container.stop();
      progress.succeed(`stopped container ${containerName}`);
    }

    let returnCode = 0;
    const backupContainer = await prepareContainer(docker, containerName, backupPath);
    for (const target of targets) {
      const exitCode = await restore(backupContainer, target);
      progress.succeed(`restored ${containerName}:${target.name} from ${path.join(backupPath, `${target.name}.tar`)}`);
      if (exitCode > returnCode) {
        returnCode = exitCode;
      }
    }
    await closeContainer(backupContainer);
    progress.succeed(`restore of ${containerName} complete (${targets.length} Volumes)`);

    process.exitCode = returnCode;

  } catch (err) {
    progress.fail();
    console.error(err);
    process.exitCode = 2;
  }
}

async function getMountsFromContainer(container: Docker.Container): Promise<Target[]> {
  const info = await container.inspect();
  return map(filter(info.Mounts, (mount: any) => mount.Type === 'volume' && mount.Driver === 'local'), (mount) => ({
    name: mount.Name,
    path: mount.Destination
  }));
}

async function pullImage(docker: Docker) {
  const image = docker.getImage('alpine:latest');
  try {
    await image.inspect();
  } catch (err) {
    progress.info(`image '${IMAGE_NAME}' not found locally - pulling image`);
    progress.start(`${bgCyan('prepare-container')} pulling '${IMAGE_NAME}'`);
    await docker.pull(IMAGE_NAME);
  }
}

async function prepareContainer(docker: Docker, forContainer: string, outputPath: string) {
  progress.start(`${bgCyan('prepare-container')} prepare container '${IMAGE_NAME}'`);
  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    Cmd: ['tail', '-f', '/dev/null'],
    HostConfig: {
      Binds: [`${path.resolve(outputPath)}:${BACKUP_MOUNT}`],
      VolumesFrom: [forContainer],
      AutoRemove: true
    }
  });
  progress.start(`${bgCyan('prepare-container')} starting container '${container.id}'`);
  await container.start({});
  return container;
}

async function prepareBackupPath(backupContainer: Docker.Container, containerName: string) {
  const dateString = format(new Date(), 'yyyy-MM-dd-HH-mm-ss');
  const backupDir = path.join(BACKUP_MOUNT, `${containerName}-${dateString}`);
  const mkdirCmd = ['mkdir', backupDir];

  progress.start(`${bgCyan('prepare-backup-path')} ${containerName}: ${join(mkdirCmd, ' ')}`);
  const exitCode = await execInContainer(backupContainer, mkdirCmd);
  if (exitCode !== 0) {
    throw new Error('mkdir command failed');
  }

  return backupDir;
}

async function backup(backupContainer: Docker.Container, backupDir: string, target: Target): Promise<number> {
  const backupPath = path.join(backupDir, `${target.name}.tar`);
  const tarCmd = ['tar', 'cf', backupPath, '.'];

  progress.start(`${bgCyan('make-backup')} ${target.name}: ${join(tarCmd, ' ')}`);
  const exitCode = await execInContainer(backupContainer, tarCmd, target.path);
  if (exitCode === 1) {
    progress.warn('tar command returned exit code 1 - backup may be incomplete');
  } else if (exitCode !== 0) {
    throw new Error(`tar command failed with exit code ${exitCode}`);
  }

  return exitCode;
}

async function restore(backupContainer: Docker.Container, target: Target): Promise<number> {
  const tarCmd = ['tar', 'xf', `${path.join(BACKUP_MOUNT, target.name)}.tar`, '--strip-components=1'];

  progress.start(`${bgCyan('restore-backup')} ${target.name}: ${join(tarCmd, ' ')}`);
  const exitCode = await execInContainer(backupContainer, tarCmd, target.path);
  if (exitCode === 1) {
    progress.warn('tar command returned exit code 1 - restore may be incomplete');
  } else if (exitCode !== 0) {
    throw new Error(`tar command failed with exit code ${exitCode}`);
  }

  return exitCode;
}

async function execInContainer(container: Docker.Container, command: string[], workingDir?: string): Promise<number> {
  const exec = await container.exec({ Cmd: command, WorkingDir: workingDir, Tty: true, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  container.modem.demuxStream(stream, new WrappedStream(progress, process.stdout), new WrappedStream(progress, process.stderr));
  await new Promise((resolve) => stream.once('end', resolve));
  const inspect = await exec.inspect();
  return inspect.ExitCode ?? 0;
}

async function closeContainer(container: Docker.Container) {
  progress.start(`${bgCyan('close-container')} stopping container '${container.id}'`);
  await container.stop();
  // progress.start(`${bgCyan('close-container')} removing container '${container.id}'`);
  // await container.remove();
}

function printUsage() {
  process.stdout.write(`USAGE: docker-volume-backup backup [options] <container names or ids...>\n`);
  process.stdout.write(`USAGE: docker-volume-backup restore [options] <container name> <backup path>\n`);
}

const argv = minimist(process.argv.slice(2));

if (argv['h'] || argv['help'] || argv._.length < 2) {
  printUsage();
  process.exit(1);
}

const outputDir: string = argv['output-dir'] ?? argv['o'];

if (argv._[0] === 'backup') {
  dockerVolumeBackup({}, { outputDir }, argv._.slice(1));
} else if (argv._[0] === 'restore') {
  dockerVolumeRestore({}, argv._[1], argv._[2] ?? '.');
} else {
  printUsage();
  process.exit(1);
}
