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

import { assign, filter, map, zipWith, sum } from 'lodash';

const IMAGE_NAME = 'alpine';

const progress = ora();

async function dockerVolumeBackup(dockerOptions: Docker.DockerOptions = {}, containers: string[]) {
  try {
    progress.start('connect-to-docker: connect to Docker daemon');
    const docker = new Docker(dockerOptions);
    await docker.ping();
    progress.succeed('connected to Docker');

    const mounts = await Promise.all(map(containers, async (name) => {
      progress.start(`get-mounts-from-container: inspecting container ${name}`);
      const container = docker.getContainer(name);

      return getMountsFromContainer(container);
    }));
    const targets = assign({}, ... zipWith(containers, mounts, (container, mount) => ({[container]: mount})));
    progress.succeed(`inspected ${containers.length} containers, found ${sum(map(targets, (target) => target.length))} volumes to backup`);

    console.log(util.inspect(targets));

    for (const name of containers) {
      const container = await prepareContainer(docker, name);
      for (const target of targets[name]) {
        await test(docker, container);
      }
      await closeContainer(container);
      progress.succeed(`backup of ${name} complete (${targets[name].length} Volumes)`);
    }
  } catch (err) {
    progress.fail();
    console.error(err);
  }
}

async function getMountsFromContainer(container: Docker.Container): Promise<string[]> {
  const info = await container.inspect();
  return map(filter(info.Mounts, (mount: any) => mount.Type === 'volume' && mount.Driver === 'local'), (mount) => mount.Destination);
}

async function prepareContainer(docker: Docker, forContainer: string) {
  progress.start(`prepare-container: pulling '${IMAGE_NAME}'`);
  const image = await docker.pull('alpine');
  progress.start(`prepare-container: prepare container '${IMAGE_NAME}'`);
  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    HostConfig: {
      Binds: [`${path.resolve('.')}:/docker-volume-backup`],
      VolumesFrom: [forContainer]
    },
    OpenStdin: true
  });
  progress.start(`prepare-container: starting container '${container.id}'`);
  await container.start({});
  return container;
}

async function test(docker: Docker, container: Docker.Container) {
  progress.start('make-backup: creating backup of ...');
  const exec = await container.exec({ Cmd: ['echo', 'Hello World'], Tty: true, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  docker.modem.demuxStream(stream, process.stdout, process.stderr);
  await new Promise((resolve) => stream.once('end', resolve));
}

async function closeContainer(container: Docker.Container) {
  progress.start(`close-container: stopping container '${container.id}'`);
  await container.stop();
  progress.start(`close-container: removing container '${container.id}'`);
  await container.remove();
}

dockerVolumeBackup({}, ['docker-test_test_1']);
