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
import Table from 'easy-table';
import minimist from 'minimist';

import { bgCyan } from 'colors/safe';
import { assign, filter, map, zipWith, sum, join } from 'lodash';
import { formatISO } from 'date-fns';
import { ToStringStream, WrappedStdoutStream } from './stream';

interface Target {
  name: string;
  path: string;
}

const IMAGE_NAME = 'alpine';
const BACKUP_MOUNT = '/docker-volume-backup';

const progress = ora();

async function dockerVolumeBackup(dockerOptions: Docker.DockerOptions = {}, containers: string[]) {
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
      const backupContainer = await prepareContainer(docker, name);
      for (const target of targets[name]) {
        const [exitCode, backupPath] = await backup(docker, backupContainer, name, target);
        progress.succeed(`backed up ${name}:${target.name} to ${path.basename(backupPath)}`);
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

async function prepareContainer(docker: Docker, forContainer: string) {
  progress.start(`${bgCyan('prepare-container')} prepare container '${IMAGE_NAME}'`);
  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    HostConfig: {
      Binds: [`${path.resolve('.')}:${BACKUP_MOUNT}`],
      VolumesFrom: [forContainer]
    },
    OpenStdin: true
  });
  progress.start(`${bgCyan('prepare-container')} starting container '${container.id}'`);
  await container.start({});
  return container;
}

async function backup(docker: Docker, container: Docker.Container, containerName: string, target: Target): Promise<[number, string]> {
  const dateString = formatISO(new Date());
  const backupPath = path.join(BACKUP_MOUNT, `backup-${containerName}-${target.name}-${dateString}.tar`);
  const tarCmd = ['tar', 'cf', backupPath, '.'];
  // const tarCmd = ['touch', backupPath];
  progress.start(`${bgCyan('make-backup')} ${containerName}:${target.name}: ${join(tarCmd, ' ')}`);
  const exec = await container.exec({ Cmd: tarCmd, WorkingDir: target.path, Tty: true, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  const stdErrStream = new ToStringStream();
  docker.modem.demuxStream(stream, new WrappedStdoutStream(progress), stdErrStream);
  await new Promise((resolve) => stream.once('end', resolve));
  if ( ! stdErrStream.isEmpty()) {
    console.error(stdErrStream.toString());
    throw new Error('tar command failed');
  }
  const inspect = await exec.inspect();
  if (inspect.ExitCode === 1) {
    progress.warn('tar command returned exit code 1 - backup may be incomplete');
  } else if (inspect.ExitCode !== 0) {
    throw new Error(`tar command failed with exit code ${inspect.ExitCode}`);
  }

  return [inspect.ExitCode, backupPath];
}

async function closeContainer(container: Docker.Container) {
  progress.start(`${bgCyan('close-container')} stopping container '${container.id}'`);
  await container.stop();
  progress.start(`${bgCyan('close-container')} removing container '${container.id}'`);
  await container.remove();
}

const argv = minimist(process.argv.slice(2));

if (argv['h'] || argv['help'] || argv._.length === 0) {
  process.stdout.write(`USAGE: docker-volume-backup [options] <container names or ids...>\n`);
  process.exit(1);
}

dockerVolumeBackup({}, argv._);
