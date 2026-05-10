import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
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

export function SettingsPage() {
  const { openHelpPanel } = useHelpPanel();

  const [logGroupName, setLogGroupName] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [cloudTrailSaveStatus, setCloudTrailSaveStatus] = useState<SaveStatus>("idle");
  const [cloudTrailSaveError, setCloudTrailSaveError] = useState("");
  const [cloudTrailSaving, setCloudTrailSaving] = useState(false);

  const [slackSaveStatus, setSlackSaveStatus] = useState<SaveStatus>("idle");
  const [slackSaveError, setSlackSaveError] = useState("");
  const [slackSaving, setSlackSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.getAppSettings();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setLogGroupName(res.data?.cloudTrailLogGroupName ?? "");
      setSlackBotToken(res.data?.slackBotToken ?? "");
      setSlackChannelId(res.data?.slackChannelId ?? "");
      setSlackSigningSecret(res.data?.slackSigningSecret ?? "");
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
      const res = await client.mutations.updateAppSettings({
        cloudTrailLogGroupName: logGroupName.trim(),
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
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
      const res = await client.mutations.updateAppSettings({
        slackBotToken: slackBotToken.trim(),
        slackChannelId: slackChannelId.trim(),
        slackSigningSecret: slackSigningSecret.trim(),
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setSlackSaveStatus("success");
    } catch (err) {
      setSlackSaveError(err instanceof Error ? err.message : "Failed to save Slack settings");
      setSlackSaveStatus("error");
    } finally {
      setSlackSaving(false);
    }
  }

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
                disabled={loading}
              />
            </FormField>

            <Box float="right">
              <Button
                variant="primary"
                onClick={handleSaveCloudTrail}
                loading={cloudTrailSaving}
                disabled={loading}
              >
                Save
              </Button>
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
                disabled={loading}
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
                disabled={loading}
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
                disabled={loading}
              />
            </FormField>

            <Box float="right">
              <Button
                variant="primary"
                onClick={handleSaveSlack}
                loading={slackSaving}
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
