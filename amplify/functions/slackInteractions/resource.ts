import { defineFunction } from "@aws-amplify/backend";

export const slackInteractiveFunction = defineFunction({
  name: "slackInteractive",
  entry: "./slackInteractiveHandler.ts",
  // Slack requires a response within 3 seconds; the AVP + Cognito + Lambda
  // chain typically runs in ~2 seconds, so 15s gives headroom on cold starts.
  timeoutSeconds: 15,
  // Must be in the data stack alongside approveRequestFunction and
  // rejectRequestFunction to avoid a circular CloudFormation dependency:
  // Amplify links all non-data-stack functions to the data stack automatically,
  // and the IAM grants reference those same data-stack Lambda ARNs.
  resourceGroupName: "data",
});
