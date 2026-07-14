import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Checkbox from "@cloudscape-design/components/checkbox";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import HelpPanel from "@cloudscape-design/components/help-panel";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";

import { useHelpPanel } from "@/components/HelpPanelContext";

const client = generateClient<Schema>();

type SaveStatus = "idle" | "success" | "error";

function CloudTrailHelpPanel() {
  return (
    <HelpPanel header={<h2>CloudTrail Audit Logs</h2>}>
      <p>
        Configure the CloudWatch Logs log group where CloudTrail delivers audit events for your AWS
        accounts. Once set, the Elevated Access page displays the full CloudTrail event history for
        each access request window.
      </p>
      <h3>How to find the log group name</h3>
      <ol>
        <li>Open the CloudTrail console and select your trail.</li>
        <li>Under <strong>CloudWatch Logs</strong>, copy the log group name (e.g.{" "}
          <code>/aws/cloudtrail/my-trail</code>).</li>
      </ol>
      <h3>How events are queried</h3>
      <p>
        Snitch filters events using the requester&apos;s email address, matching{" "}
        <code>AssumedRole</code> sessions created by SSO where the IAM ARN contains the
        email. Only events within the request&apos;s active window are returned.
      </p>
    </HelpPanel>
  );
}

function SlackHelpPanel() {
  return (
    <HelpPanel header={<h2>Slack Integration</h2>}>
      <p>
        Configure a Slack app so that approvers are notified in a Slack channel whenever an access
        request requires approval. Approvers can approve or reject the request directly from the
        message without logging in to the web UI.
      </p>
      <h3>Required Slack bot scopes</h3>
      <ul>
        <li>
          <code>chat:write</code> — post messages to channels
        </li>
        <li>
          <code>users:read.email</code> — look up a Slack user&apos;s email to match against
          configured approvers
        </li>
      </ul>
      <h3>Setup steps</h3>
      <ol>
        <li>Create a Slack app at <strong>api.slack.com/apps</strong>.</li>
        <li>Add the required bot scopes under <strong>OAuth &amp; Permissions</strong>.</li>
        <li>Install the app to your workspace and copy the <strong>Bot Token</strong>.</li>
        <li>
          Copy the <strong>Signing Secret</strong> from the app&apos;s{" "}
          <strong>Basic Information</strong> page.
        </li>
        <li>Invite the bot to the target channel and copy the <strong>Channel ID</strong>.</li>
        <li>
          After deploying the sandbox, find the <strong>Lambda Function URL</strong> in the CDK
          stack outputs and paste it into the Slack app&apos;s{" "}
          <strong>Interactivity &amp; Shortcuts → Request URL</strong>.
        </li>
      </ol>
      <h3>How approval works</h3>
      <p>
        When a request enters <strong>PENDING_APPROVAL</strong>, Snitch posts a message with the
        requester&apos;s details and Approve / Reject buttons. Clicking a button looks up your
        Slack email in Cognito, checks your authorization via AWS Verified Permissions, and
        delegates to the same approve or reject handler used by the web UI.
      </p>
    </HelpPanel>
  );
}

function NotificationsHelpPanel() {
  return (
    <HelpPanel header={<h2>Access-Request Notifications</h2>}>
      <p>
        Send a notification whenever a user requests access and when a granted access finishes
        (expires naturally or is revoked by an admin). Choose one or both delivery channels below.
      </p>
      <h3>Slack</h3>
      <p>
        Posts an informational message to the Slack channel configured in the{" "}
        <strong>Slack Integration</strong> section above. Requires the Bot Token and Channel ID to be
        set there. This is separate from the approval message (with Approve/Reject buttons), which is
        always sent for requests that require approval.
      </p>
      <h3>SNS</h3>
      <p>
        Publishes to the app-managed Amazon SNS topic shown below. To receive messages, subscribe
        email or SMS endpoints to that topic in the AWS console (SNS → Topics → Create subscription)
        and confirm the subscription.
      </p>
    </HelpPanel>
  );
}

export function SettingsPage() {
  const { openHelpPanel } = useHelpPanel();

  const [logGroupName, setLogGroupName] = useState("");
  const [savedLogGroupName, setSavedLogGroupName] = useState("");
  const [cloudTrailEditing, setCloudTrailEditing] = useState(false);

  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [savedSlackBotToken, setSavedSlackBotToken] = useState("");
  const [savedSlackChannelId, setSavedSlackChannelId] = useState("");
  const [savedSlackSigningSecret, setSavedSlackSigningSecret] = useState("");
  const [slackEditing, setSlackEditing] = useState(false);
  const [slackNotificationsEnabled, setSlackNotificationsEnabled] = useState(false);
  const [snsNotificationsEnabled, setSnsNotificationsEnabled] = useState(false);
  const [snsApprovalNotificationsEnabled, setSnsApprovalNotificationsEnabled] = useState(false);
  const [snsTopicArn, setSnsTopicArn] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [cloudTrailSaveStatus, setCloudTrailSaveStatus] = useState<SaveStatus>("idle");
  const [cloudTrailSaveError, setCloudTrailSaveError] = useState("");
  const [cloudTrailSaving, setCloudTrailSaving] = useState(false);

  const [slackSaveStatus, setSlackSaveStatus] = useState<SaveStatus>("idle");
  const [slackSaveError, setSlackSaveError] = useState("");
  const [slackSaving, setSlackSaving] = useState(false);

  const [notificationsSaveStatus, setNotificationsSaveStatus] = useState<SaveStatus>("idle");
  const [notificationsSaveError, setNotificationsSaveError] = useState("");
  const [notificationsSaving, setNotificationsSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.getAppSettings();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      const loadedLogGroup = res.data?.cloudTrailLogGroupName ?? "";
      setLogGroupName(loadedLogGroup);
      setSavedLogGroupName(loadedLogGroup);
      setCloudTrailEditing(loadedLogGroup === "");

      const loadedBotToken = res.data?.slackBotToken ?? "";
      const loadedChannelId = res.data?.slackChannelId ?? "";
      const loadedSigningSecret = res.data?.slackSigningSecret ?? "";
      setSlackBotToken(loadedBotToken);
      setSlackChannelId(loadedChannelId);
      setSlackSigningSecret(loadedSigningSecret);
      setSavedSlackBotToken(loadedBotToken);
      setSavedSlackChannelId(loadedChannelId);
      setSavedSlackSigningSecret(loadedSigningSecret);
      setSlackEditing(loadedBotToken === "" && loadedChannelId === "" && loadedSigningSecret === "");
      setSlackNotificationsEnabled(res.data?.slackNotificationsEnabled ?? false);
      setSnsNotificationsEnabled(res.data?.snsNotificationsEnabled ?? false);
      setSnsApprovalNotificationsEnabled(res.data?.snsApprovalNotificationsEnabled ?? false);
      setSnsTopicArn(res.data?.snsTopicArn ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function handleSaveCloudTrail() {
    setCloudTrailSaving(true);
    setCloudTrailSaveStatus("idle");
    setCloudTrailSaveError("");
    try {
      const trimmedLogGroup = logGroupName.trim();
      const res = await client.mutations.updateAppSettings({
        cloudTrailLogGroupName: trimmedLogGroup,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setLogGroupName(trimmedLogGroup);
      setSavedLogGroupName(trimmedLogGroup);
      setCloudTrailEditing(false);
      setCloudTrailSaveStatus("success");
    } catch (err) {
      setCloudTrailSaveError(err instanceof Error ? err.message : "Failed to save settings");
      setCloudTrailSaveStatus("error");
    } finally {
      setCloudTrailSaving(false);
    }
  }

  async function handleSaveSlack() {
    setSlackSaving(true);
    setSlackSaveStatus("idle");
    setSlackSaveError("");
    try {
      const trimmedBotToken = slackBotToken.trim();
      const trimmedChannelId = slackChannelId.trim();
      const trimmedSigningSecret = slackSigningSecret.trim();
      const res = await client.mutations.updateAppSettings({
        slackBotToken: trimmedBotToken,
        slackChannelId: trimmedChannelId,
        slackSigningSecret: trimmedSigningSecret,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setSlackBotToken(trimmedBotToken);
      setSlackChannelId(trimmedChannelId);
      setSlackSigningSecret(trimmedSigningSecret);
      setSavedSlackBotToken(trimmedBotToken);
      setSavedSlackChannelId(trimmedChannelId);
      setSavedSlackSigningSecret(trimmedSigningSecret);
      setSlackEditing(false);
      setSlackSaveStatus("success");
    } catch (err) {
      setSlackSaveError(err instanceof Error ? err.message : "Failed to save Slack settings");
      setSlackSaveStatus("error");
    } finally {
      setSlackSaving(false);
    }
  }

  async function handleSaveNotifications() {
    setNotificationsSaving(true);
    setNotificationsSaveStatus("idle");
    setNotificationsSaveError("");
    try {
      const res = await client.mutations.updateAppSettings({
        slackNotificationsEnabled,
        snsNotificationsEnabled,
        snsApprovalNotificationsEnabled,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setNotificationsSaveStatus("success");
    } catch (err) {
      setNotificationsSaveError(
        err instanceof Error ? err.message : "Failed to save notification settings"
      );
      setNotificationsSaveStatus("error");
    } finally {
      setNotificationsSaving(false);
    }
  }

  function handleCancelCloudTrail() {
    setLogGroupName(savedLogGroupName);
    setCloudTrailEditing(false);
    setCloudTrailSaveStatus("idle");
  }

  function handleCancelSlack() {
    setSlackBotToken(savedSlackBotToken);
    setSlackChannelId(savedSlackChannelId);
    setSlackSigningSecret(savedSlackSigningSecret);
    setSlackEditing(false);
    setSlackSaveStatus("idle");
  }

  const cloudTrailLocked = savedLogGroupName !== "" && !cloudTrailEditing;
  const slackConfigured =
    savedSlackBotToken !== "" || savedSlackChannelId !== "" || savedSlackSigningSecret !== "";
  const slackLocked = slackConfigured && !slackEditing;

  return (
    <ContentLayout header={<Header variant="h1">Settings</Header>}>
      <SpaceBetween size="l">
        {loadError && <Alert type="error">{loadError}</Alert>}

        <Container
          header={
            <Header
              variant="h2"
              info={
                <Link variant="info" onFollow={() => openHelpPanel(<CloudTrailHelpPanel />)}>
                  Info
                </Link>
              }
            >
              CloudTrail Audit Logs
            </Header>
          }
        >
          <SpaceBetween size="m">
            {cloudTrailSaveStatus === "success" && (
              <Alert type="success" dismissible onDismiss={() => setCloudTrailSaveStatus("idle")}>
                Settings saved successfully.
              </Alert>
            )}
            {cloudTrailSaveStatus === "error" && (
              <Alert type="error" dismissible onDismiss={() => setCloudTrailSaveStatus("idle")}>
                {cloudTrailSaveError}
              </Alert>
            )}

            <FormField
              label="CloudWatch Log Group"
              description="The log group name configured in your CloudTrail trail (e.g. /aws/cloudtrail/my-trail)."
            >
              <Input
                value={logGroupName}
                onChange={({ detail }) => {
                  setLogGroupName(detail.value);
                  setCloudTrailSaveStatus("idle");
                }}
                placeholder="/aws/cloudtrail/my-trail"
                disabled={loading || cloudTrailLocked}
              />
            </FormField>

            <Box float="right">
              {cloudTrailLocked ? (
                <Button
                  onClick={() => {
                    setCloudTrailEditing(true);
                    setCloudTrailSaveStatus("idle");
                  }}
                  disabled={loading}
                >
                  Edit
                </Button>
              ) : (
                <SpaceBetween direction="horizontal" size="xs">
                  {savedLogGroupName !== "" && (
                    <Button variant="link" onClick={handleCancelCloudTrail} disabled={loading}>
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSaveCloudTrail}
                    loading={cloudTrailSaving}
                    disabled={loading}
                  >
                    Save
                  </Button>
                </SpaceBetween>
              )}
            </Box>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              info={
                <Link variant="info" onFollow={() => openHelpPanel(<SlackHelpPanel />)}>
                  Info
                </Link>
              }
            >
              Slack Integration
            </Header>
          }
        >
          <SpaceBetween size="m">
            {slackSaveStatus === "success" && (
              <Alert type="success" dismissible onDismiss={() => setSlackSaveStatus("idle")}>
                Slack settings saved successfully.
              </Alert>
            )}
            {slackSaveStatus === "error" && (
              <Alert type="error" dismissible onDismiss={() => setSlackSaveStatus("idle")}>
                {slackSaveError}
              </Alert>
            )}

            <FormField
              label="Bot Token"
              description="The OAuth bot token for your Slack app (starts with xoxb-)."
            >
              <Input
                value={slackBotToken}
                onChange={({ detail }) => {
                  setSlackBotToken(detail.value);
                  setSlackSaveStatus("idle");
                }}
                placeholder="xoxb-..."
                disabled={loading || slackLocked}
              />
            </FormField>

            <FormField
              label="Channel ID"
              description="The Slack channel ID where approval notifications will be posted (e.g. C01234ABCDE)."
            >
              <Input
                value={slackChannelId}
                onChange={({ detail }) => {
                  setSlackChannelId(detail.value);
                  setSlackSaveStatus("idle");
                }}
                placeholder="C01234ABCDE"
                disabled={loading || slackLocked}
              />
            </FormField>

            <FormField
              label="Signing Secret"
              description="The signing secret from your Slack app's Basic Information page. Used to verify callback requests."
            >
              <Input
                value={slackSigningSecret}
                onChange={({ detail }) => {
                  setSlackSigningSecret(detail.value);
                  setSlackSaveStatus("idle");
                }}
                placeholder="Slack signing secret"
                disabled={loading || slackLocked}
              />
            </FormField>

            <Box float="right">
              {slackLocked ? (
                <Button
                  onClick={() => {
                    setSlackEditing(true);
                    setSlackSaveStatus("idle");
                  }}
                  disabled={loading}
                >
                  Edit
                </Button>
              ) : (
                <SpaceBetween direction="horizontal" size="xs">
                  {slackConfigured && (
                    <Button variant="link" onClick={handleCancelSlack} disabled={loading}>
                      Cancel
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSaveSlack}
                    loading={slackSaving}
                    disabled={loading}
                  >
                    Save
                  </Button>
                </SpaceBetween>
              )}
            </Box>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              info={
                <Link variant="info" onFollow={() => openHelpPanel(<NotificationsHelpPanel />)}>
                  Info
                </Link>
              }
              description="Notify when a user requests access and when a granted access finishes (expires or is revoked)."
            >
              Access-Request Notifications
            </Header>
          }
        >
          <SpaceBetween size="m">
            {notificationsSaveStatus === "success" && (
              <Alert type="success" dismissible onDismiss={() => setNotificationsSaveStatus("idle")}>
                Notification settings saved successfully.
              </Alert>
            )}
            {notificationsSaveStatus === "error" && (
              <Alert type="error" dismissible onDismiss={() => setNotificationsSaveStatus("idle")}>
                {notificationsSaveError}
              </Alert>
            )}

            <FormField
              label="Slack"
              description="Requires the Bot Token and Channel ID configured in Slack Integration above."
            >
              <Checkbox
                checked={slackNotificationsEnabled}
                disabled={loading}
                onChange={({ detail }) => {
                  setSlackNotificationsEnabled(detail.checked);
                  setNotificationsSaveStatus("idle");
                }}
              >
                Send access-request notifications to Slack
              </Checkbox>
            </FormField>

            <FormField
              label="Amazon SNS"
              description="Publishes to the app-managed SNS topic. Subscribe endpoints to the topic below to receive messages."
            >
              <SpaceBetween size="xs">
                <Checkbox
                  checked={snsNotificationsEnabled}
                  disabled={loading}
                  onChange={({ detail }) => {
                    setSnsNotificationsEnabled(detail.checked);
                    setNotificationsSaveStatus("idle");
                  }}
                >
                  Send access-request notifications (requested / finished) to Amazon SNS
                </Checkbox>
                <Checkbox
                  checked={snsApprovalNotificationsEnabled}
                  disabled={loading}
                  onChange={({ detail }) => {
                    setSnsApprovalNotificationsEnabled(detail.checked);
                    setNotificationsSaveStatus("idle");
                  }}
                >
                  Send approval requests to Amazon SNS (links to the Approve Requests page)
                </Checkbox>
              </SpaceBetween>
            </FormField>

            <FormField
              label="SNS Topic ARN"
              description="Read-only. Subscribe email/SMS endpoints to this topic in the AWS console to receive notifications."
            >
              <Input
                value={snsTopicArn}
                readOnly
                disabled={loading}
                placeholder={loading ? "Loading…" : "Deploy the backend to create the topic"}
              />
            </FormField>

            <Box float="right">
              <Button
                variant="primary"
                onClick={handleSaveNotifications}
                loading={notificationsSaving}
                disabled={loading}
              >
                Save
              </Button>
            </Box>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
