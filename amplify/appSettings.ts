import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, IFunction } from "aws-cdk-lib/aws-lambda";
import { RemovalPolicy, Stack } from "aws-cdk-lib";

interface AppSettingsParams {
  settingsStack: Stack;
  getSettingsFn: IFunction;
  updateSettingsFn: IFunction;
  getCloudTrailLogsFn: IFunction;
  storeApprovalTokenFn: IFunction;
  requestAccessFn: IFunction;
  removePermissionSetFn: IFunction;
  accessRequestTableArn: string;
  notificationsTopicArn: string;
}

export function setupAppSettings({
  settingsStack,
  getSettingsFn,
  updateSettingsFn,
  getCloudTrailLogsFn,
  storeApprovalTokenFn,
  requestAccessFn,
  removePermissionSetFn,
  accessRequestTableArn,
  notificationsTopicArn,
}: AppSettingsParams): Table {
  const appSettingsTable = new Table(settingsStack, "AppSettingsTable", {
    partitionKey: { name: "settingKey", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    removalPolicy: RemovalPolicy.RETAIN,
  });

  const settingsDdbPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
    resources: [appSettingsTable.tableArn],
  });

  for (const fn of [getSettingsFn, updateSettingsFn]) {
    fn.addToRolePolicy(settingsDdbPolicy);
    (fn as LambdaFunction).addEnvironment("APP_SETTINGS_TABLE_NAME", appSettingsTable.tableName);
  }

  getCloudTrailLogsFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [appSettingsTable.tableArn],
    })
  );
  getCloudTrailLogsFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      // Log group name is admin-configured at runtime, so resource ARN is unknown at synth time.
      actions: ["logs:FilterLogEvents"],
      resources: ["*"],
    })
  );
  (getCloudTrailLogsFn as LambdaFunction).addEnvironment(
    "APP_SETTINGS_TABLE_NAME",
    appSettingsTable.tableName
  );

  storeApprovalTokenFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [accessRequestTableArn, appSettingsTable.tableArn],
    })
  );
  (storeApprovalTokenFn as LambdaFunction).addEnvironment(
    "APP_SETTINGS_TABLE_NAME",
    appSettingsTable.tableName
  );

  // requestAccess + removePermissionSet read the notification toggles/Slack config
  // from the settings table before dispatching access-event notifications. (SNS
  // publish + NOTIFICATIONS_TOPIC_ARN are granted in setupAccessRequestWorkflow.)
  for (const fn of [requestAccessFn, removePermissionSetFn]) {
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [appSettingsTable.tableArn],
      })
    );
    (fn as LambdaFunction).addEnvironment("APP_SETTINGS_TABLE_NAME", appSettingsTable.tableName);
  }

  // getAppSettings surfaces the CDK-managed topic ARN read-only so admins can
  // subscribe endpoints; it reads it from the environment, not DynamoDB.
  (getSettingsFn as LambdaFunction).addEnvironment(
    "NOTIFICATIONS_TOPIC_ARN",
    notificationsTopicArn
  );

  return appSettingsTable;
}
