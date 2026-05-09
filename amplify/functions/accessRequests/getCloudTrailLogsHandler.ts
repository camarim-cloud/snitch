import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const APP_SETTINGS_TABLE_NAME = process.env.APP_SETTINGS_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const logsClient = new CloudWatchLogsClient({ region: REGION });

const SETTINGS_KEY = "global";
const MAX_EVENTS = 1000;

type AppSyncEvent = {
  arguments: {
    startTime: string;
    endTime: string;
    idcUserEmail: string;
  };
  identity: unknown;
};

type CloudTrailEvent = {
  eventVersion?: string;
  eventTime?: string;
  eventSource?: string;
  eventName?: string;
  awsRegion?: string;
  sourceIPAddress?: string;
  eventID?: string;
  readOnly?: boolean;
  errorCode?: string;
  errorMessage?: string;
  userIdentity?: {
    type?: string;
    arn?: string;
    userName?: string;
    principalId?: string;
  };
};

function parseCloudTrailEvent(message: string): CloudTrailEvent | null {
  try {
    const parsed = JSON.parse(message);
    // Some deliveries wrap events in { Records: [...] }; use first record if so
    if (Array.isArray(parsed?.Records) && parsed.Records.length > 0) {
      return parsed.Records[0] as CloudTrailEvent;
    }
    return parsed as CloudTrailEvent;
  } catch {
    return null;
  }
}

function resolveUserIdentityArn(userIdentity: CloudTrailEvent["userIdentity"]): string {
  return userIdentity?.arn ?? userIdentity?.userName ?? userIdentity?.principalId ?? "";
}

function toLogEventResult(raw: FilteredLogEvent, ct: CloudTrailEvent) {
  return {
    eventId: raw.eventId ?? "",
    timestamp: raw.timestamp ? new Date(raw.timestamp).toISOString() : "",
    eventTime: ct.eventTime ?? "",
    eventName: ct.eventName ?? "",
    eventSource: ct.eventSource ?? "",
    userIdentityType: ct.userIdentity?.type ?? "",
    userIdentityArn: resolveUserIdentityArn(ct.userIdentity),
    sourceIPAddress: ct.sourceIPAddress ?? "",
    awsRegion: ct.awsRegion ?? "",
    errorCode: ct.errorCode ?? "",
    errorMessage: ct.errorMessage ?? "",
    readOnly: ct.readOnly ?? null,
  };
}

export const handler = async (event: AppSyncEvent) => {
  const { startTime, endTime, idcUserEmail } = event.arguments;

  const settingsResult = await dynamo.send(
    new GetCommand({ TableName: APP_SETTINGS_TABLE_NAME, Key: { settingKey: SETTINGS_KEY } })
  );

  const logGroupName: string | undefined = settingsResult.Item?.cloudTrailLogGroupName;
  if (!logGroupName) return [];

  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();

  const results: ReturnType<typeof toLogEventResult>[] = [];
  let nextToken: string | undefined;

  do {
    const response = await logsClient.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: startMs,
        endTime: endMs,
        // Text search: matches events whose JSON contains the user's email anywhere
        // (catches AssumedRole sessions where userIdentity.arn ends with the email)
        filterPattern: `?"${idcUserEmail}"`,
        nextToken,
        limit: 100,
      })
    );

    for (const raw of response.events ?? []) {
      if (!raw.message) continue;
      const ct = parseCloudTrailEvent(raw.message);
      if (!ct) continue;
      results.push(toLogEventResult(raw, ct));
      if (results.length >= MAX_EVENTS) break;
    }

    nextToken = response.nextToken;
  } while (nextToken && results.length < MAX_EVENTS);

  return results;
};
