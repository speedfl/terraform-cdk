import https = require("https");
import { format } from "url";
import { v4 as uuidv4 } from "uuid";
import * as os from "os";
import ciDetect from "@npmcli/ci-detect";
import { logger, processLoggerError } from "./logging";
import { versionNumber } from "../bin/cmds/helper/version-check";
import * as path from "path";
import * as fs from "fs-extra";

const BASE_URL = `https://checkpoint-api.hashicorp.com/v1/`;

const VALID_STATUS_CODES = [200, 201];

export interface ReportParams {
  dateTime?: Date;
  arch?: string;
  os?: string;
  payload: Record<string, any>;
  product: string;
  runID?: string;
  version?: string;
  command?: string;
  language?: string;
  userId?: string;
  ci?: string;
  projectId?: string;
}

async function post(url: string, data: string) {
  return new Promise<void>((ok, ko) => {
    const req = https.request(
      format(url),
      {
        headers: {
          Accept: "application/json",
          "Content-Length": data.length,
          "User-Agent": "HashiCorp/cdktf-cli",
        },
        method: "POST",
      },
      (res) => {
        if (res.statusCode) {
          const statusCode = res.statusCode;
          if (!VALID_STATUS_CODES.includes(statusCode)) {
            return ko(new Error(res.statusMessage));
          }
        }
        const data = new Array<Buffer>();
        res.on("data", (chunk) => data.push(chunk));
        res.on("error", (err) => ko(err));
        res.on("end", () => {
          return ok();
        });
      }
    );

    req.setTimeout(1000, () => ko(new Error("request timeout")));
    req.write(data);
    req.end();
    req.on("error", (err) => ko(err));
  });
}

export async function sendTelemetry(
  command: string,
  payload: Record<string, any>
) {
  const reportParams: ReportParams = {
    command,
    product: "cdktf",
    version: versionNumber(),
    dateTime: new Date(),
    language: payload.language,
    payload,
  };

  try {
    await ReportRequest(reportParams);
  } catch (err) {
    logger.error(`Could not send telemetry data: ${err}`);
  }
}

function getId(
  filePath: string,
  key: string,
  explanatoryComment?: string
): string {
  // If the file doesn't exist, we don't have an ID. So we create a file with the ID for next time
  const _uuid = uuidv4();
  const _idFile = {} as Record<string, string>;
  if (explanatoryComment) {
    _idFile["//"] = explanatoryComment.replaceAll("\n", " ");
  }
  _idFile[key] = _uuid;

  let jsonFile;
  try {
    jsonFile = require(filePath);
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(_idFile, null, 2));
    return _uuid;
  }

  if (jsonFile[key]) {
    return jsonFile[key];
  } else {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...jsonFile, [key]: _uuid }, null, 2)
    );
    return _uuid;
  }
}

function getProjectId(projectPath = process.cwd()): string {
  return getId(path.resolve(projectPath, "cdktf.json"), "projectId");
}

function getUserId(): string {
  return getId(
    path.resolve(os.homedir(), ".cdktf", "config.json"),
    "userId",
    `This signature is a randomly generated UUID used to anonymously differentiate users in telemetry data order to inform product direction. 
This signature is random, it is not based on any personally identifiable information. 
To create a new signature, you can simply delete this file at any time.
See https://github.com/hashicorp/terraform-cdk/blob/main/docs/working-with-cdk-for-terraform/telemetry.md for more
information on how to disable it.`
  );
}

export async function ReportRequest(reportParams: ReportParams): Promise<void> {
  // we won't report when checkpoint is disabled.
  if (process.env.CHECKPOINT_DISABLE) {
    return;
  }

  if (!reportParams.runID) {
    reportParams.runID = uuidv4();
  }

  if (!reportParams.dateTime) {
    reportParams.dateTime = new Date();
  }

  if (!reportParams.arch) {
    reportParams.arch = os.arch();
  }

  if (!reportParams.os) {
    reportParams.os = os.platform();
  }

  const ci: string | false = ciDetect();
  if (!reportParams.userId && !ci) {
    reportParams.userId = getUserId();
  }

  if (ci) {
    reportParams.ci = ci;
  }

  reportParams.projectId = reportParams.projectId || getProjectId();

  const postData = JSON.stringify(reportParams);

  try {
    await post(`${BASE_URL}telemetry/${reportParams.product}`, postData);
  } catch (e) {
    // Log errors writing to checkpoint
    processLoggerError(e.message);
  }
}
