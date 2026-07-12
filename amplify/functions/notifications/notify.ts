import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const sns = new SNSClient({ region: REGION });

/**
 * Renders a total-minute integer as a short human label: "45min", "1h 30min",
 * "2d 8h". Shared by the Slack sender and the access-event notifications so the
 * duration always reads the same way across channels.
 */
export function formatDurationMinutes(minutes: number): string {
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}min`);
  return parts.join(" ") || "0min";
}

export type AccessEventKind = "REQUESTED" | "FINISHED";

// Only the fields the notifications read. Sourced from the AppSettings "global"
// record (Slack config + the two enable toggles).
export type NotificationSettings = {
  slackNotificationsEnabled?: boolean | null;
  slackBotToken?: string | null;
  slackChannelId?: string | null;
  snsNotificationsEnabled?: boolean | null;
  snsApprovalNotificationsEnabled?: boolean | null;
};

// A subset of the AccessRequestItem — the display context both channels use.
export type NotifiableRequest = {
  idcUserDisplayName?: string | null;
  idcUserEmail?: string | null;
  accountId: string;
  accountName?: string | null;
  permissionSetArn: string;
  permissionSetName?: string | null;
  durationMinutes: number;
  justification?: string | null;
  status?: string | null;
  revokeComment?: string | null;
};

type NotifyParams = {
  kind: AccessEventKind;
  request: NotifiableRequest;
  settings: NotificationSettings;
  topicArn?: string | null;
};

type MessageContent = { subject: string; title: string; lines: string[] };

// "accountName (accountId)", or just the id when no name is stored.
function accountLabel(request: NotifiableRequest): string {
  return request.accountName
    ? `${request.accountName} (${request.accountId})`
    : request.accountId;
}

// The requester/account/permission-set/duration lines shared by every message.
function baseRequestLines(request: NotifiableRequest): string[] {
  const requester = `${request.idcUserDisplayName ?? "Unknown"} (${request.idcUserEmail ?? ""})`;
  const permissionSet = request.permissionSetName ?? request.permissionSetArn;

  return [
    `Requester: ${requester}`,
    `Account: ${accountLabel(request)}`,
    `Permission Set: ${permissionSet}`,
    `Duration: ${formatDurationMinutes(request.durationMinutes)}`,
  ];
}

function buildMessage({ kind, request }: NotifyParams): MessageContent {
  const lines = baseRequestLines(request);
  // Subject verb tracks the lifecycle end: "started" for REQUESTED, "finished"
  // for FINISHED. Includes the account so admins can filter their inbox.
  const verb = kind === "REQUESTED" ? "started" : "finished";
  const subject = `AWS access session ${verb} - ${accountLabel(request)}`;

  if (kind === "REQUESTED") {
    lines.push(`Justification: ${request.justification ?? "(none)"}`);
    lines.push(`Status: ${request.status ?? "PENDING"}`);
    return { subject, title: "Access Requested", lines };
  }

  // FINISHED — status is REVOKED (admin) or EXPIRED (natural expiry).
  lines.push(`Status: ${request.status ?? "EXPIRED"}`);
  if (request.status === "REVOKED" && request.revokeComment) {
    lines.push(`Revoke reason: ${request.revokeComment}`);
  }
  return { subject, title: "Access Finished", lines };
}

function toSlackBlocks({ title, lines }: MessageContent) {
  return [
    { type: "header", text: { type: "plain_text", text: title } },
    {
      type: "section",
      fields: lines.map((line) => ({ type: "mrkdwn", text: line })),
    },
  ];
}

async function sendSlack(content: MessageContent, botToken: string, channelId: string): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, blocks: toSlackBlocks(content) }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
}

async function sendSns(content: MessageContent, topicArn: string): Promise<void> {
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: content.subject.slice(0, 100), // SNS subject hard limit is 100 chars
      Message: [content.title, "", ...content.lines].join("\n"),
    })
  );
}

/**
 * Best-effort access-event notification. Publishes to Slack and/or SNS depending
 * on the admin's per-channel toggles in Settings. Each channel is independent and
 * failures are logged, never thrown — notification delivery must never fail the
 * access-request workflow (mirrors the approval Slack sender's behavior).
 *
 * Example: await notifyAccessEvent({ kind: "REQUESTED", request, settings, topicArn })
 */
export async function notifyAccessEvent(params: NotifyParams): Promise<void> {
  const { settings, topicArn } = params;
  const content = buildMessage(params);

  const slackEnabled =
    settings.slackNotificationsEnabled === true && settings.slackBotToken && settings.slackChannelId;
  if (slackEnabled) {
    try {
      await sendSlack(content, settings.slackBotToken!, settings.slackChannelId!);
    } catch (err) {
      console.error(
        "Slack access-event notification failed",
        JSON.stringify(err, Object.getOwnPropertyNames(err))
      );
    }
  }

  const snsEnabled = settings.snsNotificationsEnabled === true && topicArn;
  if (snsEnabled) {
    try {
      await sendSns(content, topicArn!);
    } catch (err) {
      console.error(
        "SNS access-event notification failed",
        JSON.stringify(err, Object.getOwnPropertyNames(err))
      );
    }
  }
}

type ApprovalNotifyParams = {
  request: NotifiableRequest;
  settings: NotificationSettings;
  topicArn?: string | null;
  appUrl?: string | null;
};

/**
 * Best-effort SNS notification that a request is waiting for approval. Unlike the
 * Slack approval message (which carries interactive Approve/Reject buttons), the
 * SNS email cannot authorize the clicker, so it links to the in-app Approve
 * Requests page where the approver logs in and acts with full authorization.
 *
 * SNS-only and gated by its own toggle, independent of notifyAccessEvent. Never
 * throws — notification delivery must not fail the approval workflow.
 *
 * Example: await notifyPendingApproval({ request, settings, topicArn, appUrl })
 */
export async function notifyPendingApproval({
  request,
  settings,
  topicArn,
  appUrl,
}: ApprovalNotifyParams): Promise<void> {
  if (settings.snsApprovalNotificationsEnabled !== true || !topicArn) return;

  const lines = baseRequestLines(request);
  lines.push(`Justification: ${request.justification ?? "(none)"}`);
  lines.push(`Review and approve or reject: ${appUrl ?? ""}#/approve-requests`);

  const subject = `AWS access approval required - ${accountLabel(request)}`;

  try {
    await sendSns({ subject, title: "Access Approval Required", lines }, topicArn);
  } catch (err) {
    console.error(
      "SNS approval notification failed",
      JSON.stringify(err, Object.getOwnPropertyNames(err))
    );
  }
}
