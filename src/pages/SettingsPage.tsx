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
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";

const client = generateClient<Schema>();

export function SettingsPage() {
  const [logGroupName, setLogGroupName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.getAppSettings();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setLogGroupName(res.data?.cloudTrailLogGroupName ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function handleSave() {
    setSaving(true);
    setSaveStatus("idle");
    setSaveError("");
    try {
      const res = await client.mutations.updateAppSettings({
        cloudTrailLogGroupName: logGroupName.trim(),
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setSaveStatus("success");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ContentLayout header={<Header variant="h1">Settings</Header>}>
      <SpaceBetween size="l">
        {loadError && <Alert type="error">{loadError}</Alert>}

        <Container header={<Header variant="h2">CloudTrail Audit Logs</Header>}>
          <SpaceBetween size="m">
            <Box color="text-body-secondary">
              Configure the CloudWatch log group where CloudTrail delivers audit events.
              This log group is used in Elevated Access to display the audit trail for
              each access request.
            </Box>

            {saveStatus === "success" && (
              <Alert type="success" dismissible onDismiss={() => setSaveStatus("idle")}>
                Settings saved successfully.
              </Alert>
            )}
            {saveStatus === "error" && (
              <Alert type="error" dismissible onDismiss={() => setSaveStatus("idle")}>
                {saveError}
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
                  setSaveStatus("idle");
                }}
                placeholder="/aws/cloudtrail/my-trail"
                disabled={loading}
              />
            </FormField>

            <Box float="right">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saving}
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
