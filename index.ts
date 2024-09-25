import { exec } from "child_process";
import { format, subSeconds } from "date-fns";
import { CronJob } from "cron";
import fs from "fs";
import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
  ListObjectsCommandInput,
  ListObjectsCommand,
  DeleteObjectsCommandInput,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const DUMPS_PATH = process.env.DUMPS_PATH || `/dumps`;
const DATETIME_FORMAT = "yyyy-MM-dd_HH-mm-ss";
const DAILY_FORMAT = "yyyy-MM-dd";
const HOURLY_FORMAT = "yyyy-MM-dd_HH";

// if needed, we should create the dumps folder
if (!fs.existsSync(DUMPS_PATH)) {
  console.log(`Dumps folder has been created (${DUMPS_PATH})`);
  fs.mkdirSync(DUMPS_PATH, { recursive: true });
}

// prepare s3
const s3 =
  process.env.S3_API_KEY &&
  process.env.S3_API_SECRET &&
  process.env.S3_API_ENDPOINT &&
  process.env.S3_BUCKET_NAME
    ? new S3Client({
        credentials: {
          accessKeyId: process.env.S3_API_KEY,
          secretAccessKey: process.env.S3_API_SECRET,
        },
        region: process.env.S3_REGION,
        endpoint: process.env.S3_API_ENDPOINT,
        forcePathStyle: true,
      })
    : undefined;

// start cron job (run every hour)
new CronJob(
  "*/15 * * * *",
  dump,
  () => {
    console.log(`Dump job has been completed`);
  },
  false,
  "Europe/Paris"
).start();

// run a sh command as a Promise, it returns a promise with the output
function sh(command: string, cwd: string) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
        return reject();
      }
      if (stderr) {
        return reject(stderr);
      }
      resolve(stdout);
    });
  });
}

// run the dump routine
async function dump() {
  // get all containers ids with fr.aleygues.pgdump label
  let containersIds: string[] = [];
  {
    const output = (await sh(
      "docker ps -q -f 'label=fr.aleygues.pgdump'",
      "."
    )) as string;
    containersIds = output
      .split("\n")
      .map((e) => e.trim())
      .filter((e) => !!e);
  }

  console.log(`${containersIds.length} container(s) to dump found`);
  if (!containersIds.length) {
    return;
  }

  // inspect these containers to get labels information
  let containersData: {
    id: string;
    username: string;
    prefix: string;
    frequency: "daily" | "hourly" | "weekly";
    daysRetention: number;
  }[] = [];
  {
    const output = (await sh(
      `docker inspect ${containersIds.join(" ")}`,
      "."
    )) as string;
    const json = JSON.parse(output);

    const passedPrefixes: string[] = [];
    for (const container of json) {
      const labels = container.Config.Labels;

      if ("fr.aleygues.pgdump" in labels === false) {
        console.warn(`Container ${container.Id} does not has pgdump label`);
        continue;
      }

      if (
        typeof labels["fr.aleygues.pgdump.username"] !== "string" ||
        !labels["fr.aleygues.pgdump.username"]
      ) {
        console.error(
          `Container ${container.Id} must have pgdump.username label`
        );
        continue;
      }

      if (
        typeof labels["fr.aleygues.pgdump.prefix"] !== "string" ||
        !labels["fr.aleygues.pgdump.prefix"]
      ) {
        console.error(
          `Container ${container.Id} must have pgdump.prefix label`
        );
        continue;
      }

      const prefix = labels["fr.aleygues.pgdump.prefix"];
      if (passedPrefixes.includes(prefix)) {
        console.error(`Container ${container.Id} uses a prefix already used`);
        continue;
      }

      if (
        typeof labels["fr.aleygues.pgdump.frequency"] === "string" &&
        ["daily", "hourly", "weekly"].includes(
          labels["fr.aleygues.pgdump.frequency"]
        ) === false
      ) {
        console.error(
          `Container ${container.Id} uses a frequency that does not exist (${labels["fr.aleygues.pgdump.frequency"]})`
        );
        continue;
      }

      if (
        typeof labels["fr.aleygues.pgdump.daysRetention"] === "string" &&
        /^[0-9]+$/.test(labels["fr.aleygues.pgdump.daysRetention"]) === false
      ) {
        console.error(
          `Container ${container.Id} uses an invalid pgdump.daysRetention value`
        );
        continue;
      }

      containersData.push({
        id: container.Id,
        username: labels["fr.aleygues.pgdump.username"],
        prefix: labels["fr.aleygues.pgdump.prefix"],
        frequency: labels["fr.aleygues.pgdump.frequency"] || "daily",
        daysRetention: labels["fr.aleygues.pgdump.daysRetention"]
          ? Number(labels["fr.aleygues.pgdump.daysRetention"])
          : 7,
      });
    }
  }

  // generate dumps
  let remoteDumps: string[] = [];
  try {
    remoteDumps = await getRemoteDumps();
  } catch {
    console.error(`Unable to list all s3 objects`);
    return;
  }
  for (const container of containersData) {
    // we should check if we need to generate the dump
    const searchKey = `pgdump_${container.prefix}_${format(
      new Date(),
      container.frequency === "daily" ? DAILY_FORMAT : HOURLY_FORMAT
    )}`;

    if (remoteDumps.find((dump) => dump.startsWith(searchKey))) {
      continue;
    }

    try {
      const path = `/dumps/pgdump_${container.prefix}_${format(
        new Date(),
        DATETIME_FORMAT
      )}.sql`;
      await sh(
        `docker exec ${container.id} pg_dumpall -c -U ${container.username} > ${path}`,
        "."
      );
      console.log(
        `Dump of container ${container.id} has been generated, pushing`
      );

      // here we may think it's OK!
      try {
        await pushDump(path, container.prefix, container.daysRetention);
        console.log(
          `Dump of container ${container.id} has been pushed, cleaning`
        );

        try {
          await clearDumps(
            container.prefix,
            container.daysRetention,
            remoteDumps
          );
          console.log(
            `Dumps starting with pgdump_${container.prefix} and older than ${container.daysRetention} days has been deleted`
          );
        } catch {
          console.error(
            `Unable to clean old dumps for prefix ${container.prefix} and days retention of ${container.daysRetention}`
          );
        }
      } catch {
        console.error(`Unable to push ${path}`);
      }
    } catch (e) {
      console.debug(`Error is: `, e);
      console.error(`Error dumping container ${container.id}`);
      continue;
    }
  }
}

async function getRemoteDumps(): Promise<string[]> {
  const bucketParams: ListObjectsCommandInput = {
    Bucket: process.env.S3_BUCKET_NAME,
  };

  const result = await s3?.send(new ListObjectsCommand(bucketParams));

  if (
    !result ||
    (result.$metadata.httpStatusCode && result.$metadata.httpStatusCode > 299)
  ) {
    throw new Error();
  }

  return result.Contents?.map((content) => content.Key ?? "") ?? [];
}

async function pushDump(path: string, prefix: string, daysRetention: number) {
  // first, push new dump
  const fileContent = fs.readFileSync(path);
  const filename = path.split("/").pop();

  const bucketParams: PutObjectCommandInput = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: filename,
    Body: fileContent,
  };

  const result = await s3?.send(new PutObjectCommand(bucketParams));

  if (
    !result ||
    (result.$metadata.httpStatusCode && result.$metadata.httpStatusCode > 299)
  ) {
    throw new Error();
  }

  // if it succeed, we should delete the old ones
  try {
    const fileContent = fs.readFileSync(path);
    const filename = path.split("/").pop();

    const bucketParams: PutObjectCommandInput = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: filename,
      Body: fileContent,
    };

    const result = await s3?.send(new PutObjectCommand(bucketParams));

    if (
      !result ||
      (result.$metadata.httpStatusCode && result.$metadata.httpStatusCode > 299)
    ) {
      console.error(`Unable to push ${filename}`);
      return;
    }
  } catch (e) {
    console.error(`Unable to push`);
    return;
  }
}

async function clearDumps(
  prefix: string,
  daysRetention: number,
  remoteDumps: string[]
) {
  const fullPrefixWithUnderscore = `pgdump_${prefix}_`;
  const dumps = remoteDumps.filter((dump) =>
    dump.startsWith(fullPrefixWithUnderscore)
  );

  const minDatetime = `${fullPrefixWithUnderscore}${format(
    subSeconds(new Date(), daysRetention),
    DATETIME_FORMAT
  )}.sql`;

  const dumpsToDelete = dumps.filter((dump) => dump < minDatetime);

  if (dumpsToDelete.length) {
    const bucketParams: DeleteObjectsCommandInput = {
      Bucket: process.env.S3_BUCKET_NAME,
      Delete: {
        Objects: dumpsToDelete.map((dump) => ({
          Key: dump,
        })),
      },
    };

    const result = await s3?.send(new DeleteObjectsCommand(bucketParams));

    if (
      !result ||
      (result.$metadata.httpStatusCode && result.$metadata.httpStatusCode > 299)
    ) {
      throw new Error();
    }
  }
}
