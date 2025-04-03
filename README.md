# pgdump-to-s3

This repo (and its built Docker image) should be used to generate PostreSQL dumps (using `pgdump`) automatically and upload them to a remote location (using S3 API). 

The image has been thought to be used on a Docker Swarm infrastructure (but should be easily adapted to a Docker Compose environment). 

All stacks deployed **on the same node** presenting **labels** described bellow will be handled. Dump process runs every 15 minutes (cannot be customized yet). 

## Deploy the stack

```yml
version: "3"

services:
    pgdumptos3:
        image: aleygues/pgdump-to-s3
        restart: always
        environment:
            - S3_API_KEY=
            - S3_API_SECRET=
            - S3_REGION=
            - S3_API_ENDPOINT=
            - S3_BUCKET_NAME=
        volumes:
            - /var/run/docker.sock:/var/run/docker.sock
        deploy:
            mode: global
            placement:
                constraints: [node.labels.pgdump == true] # you may change this depending on your needs
```

## Update PostreSQL services

```yml
version: '3'
services:
  db:
    image: postgres:15.10-alpine3.21
    environment:
      POSTGRES_PASSWORD: supersecret
    volumes:
      - db-data:/var/lib/postgresql/data
    # -- starts labels example
    labels:
      - fr.aleygues.pgdump
      - fr.aleygues.pgdump.username= # your PostgresSQL user
      - fr.aleygues.pgdump.prefix= # prefix used to generate dumps
      - fr.aleygues.pgdump.frequency=daily # daily or hourly
      - fr.aleygues.pgdump.daysRetention=7 # number of days the dumps should be kept
    ## -- ends labels example
    networks:
      - app
    deploy:
      placement:
        constraints: [node.labels.nodeId == 1] # this is an example
volumes:
  db-data:
    driver: local
networks:
  app:
```

## Check if it's working

You should wait for the next 15 minutes tick (HH:00, HH:15, ...), and the logs of the dump service, then check the generated dump file

## Good practices 

Here are some good practices:
- check the dump integrity (does it contains all SQL code you need to restart your database?)
- do this verification regularly (every month for instance)
- train yourself to restart an app from its generated backup
- document everything on a document (and this should be the main part of your DRP)

Enjoy!
