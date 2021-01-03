# Docker Volume Backup

A simple command-line tool to take and restore backups of the volumes of a docker container.

The tool basically automates the steps outlined in the [official Docker documentation](https://docs.docker.com/storage/volumes/#backup-restore-or-migrate-data-volumes).

*EXPERIMENTAL WORK IN PROGRESS!*

## Installation

Install via npm
```
npm install -g docker-volume-backup
```

Or build from source:
```
git clone https://github.com/Vortex375/docker-volume-backup.git
cd docker-volume-backup
npm install
npm run build
npm install -g dist
```

## Taking a backup

To take a backup, simply give the names of one or more containers that you want to back up. If the containers are currently running, they are automatically stopped and restarted after the backup. The containers will be stopped and backed up in the given order, then restarted in the reverse order.

To take a backup, run `docker-volume-backup` with the "backup" command and a list of containers. It will write the backups to the current directory. Optionally, you can specify the backup location with the `-o` switch:
```
# docker-volume-backup backup my-app my-db -o /path/to/backup/
✅ connected to Docker
✅ inspected 2 containers, found 3 volumes to backup
ℹ️ Backup Targets:

Container  Volume
---------  ---------------

my-app     data:/data
           config:/etc/app

my-db      db:/var/lib/db

✅ backed up my-app:data to /path/to/backup/my-app-2021-01-03-23-47-25/data.tar
✅ backed up my-app:config to /path/to/backup/my-app-2021-01-03-23-47-25/config.tar
✅ backup of my-app complete (2 Volumes)
✅ backed up my-db:db to /path/to/backup/my-db-2021-01-03-23-47-36/db.tar
✅ backup of my-db complete (1 Volumes)
✅ started container my-db
✅ started container my-app

```
It will create a new folder with the container name and timestamp. Inside the folder will be a tar file for each volume that was backed up.

## Restore from backup

Restore is equally easy. Simply give the name of a container and the path to the backup location (the folder containing tar files, created by the "backup" command). If the container is currently running, it is stopped but _not_ automatically restarted.

To restore from a backup run `docker-volume-backup` with the "restore" command, a container name and the path to the backup:
```
# docker-volume-backup restore my-app backup/my-app-2021-01-03-23-47-25
✅ connected to Docker
ℹ️ Restore Targets:

Container  Volume             From
---------  -----------------  --------------------------------------------

my-app     ✓ data:/data       backup/my-app-2021-01-03-23-47-25/data.tar
           ✓ config:/etc/app  backup/my-app-2021-01-03-23-47-25/config.tar

✅ restored my-app:data from backup/my-app-2021-01-03-23-47-25/data.tar
✅ restored my-app:config from backup/my-app-2021-01-03-23-47-25/config.tar
✅ restore of my-app complete (2 Volumes)
```

In case the backup folder does not contain a backup for each volume, then a partial restore of the available volumes is performed. The tool informs you which volumes are being restored:
```
# docker-volume-backup restore my-app partial-backup/my-app-2021-01-03-23-47-25
✅ connected to Docker
ℹ️ Restore Targets:

Container  Volume             From
---------  -----------------  ------------------------------------------

my-app     ✓ data:/data       partial-backup/my-app-2021-01-03-23-47-25/data.tar
           ❌ config:/etc/app  (no backup file found)

✅ restored my-app:data from partial-backup/my-app-2021-01-03-23-47-25/data.tar
✅ restore of my-app complete (1 Volumes)

```