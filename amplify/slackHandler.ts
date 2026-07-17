import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { IUserPool } from "aws-cdk-lib/aws-cognito";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { requireSynthEnv } from "./synthEnv";

interface SlackHandlerParams {
  slackLambda: LambdaFunction;
  approveRequestLambda: LambdaFunction;
  rejectRequestLambda: LambdaFunction;
  policyStoreArn: string;
  policyStoreId: string;
  appSettingsTable: ITable;
  accessRequestTableArn: string;
  accessRequestTableName: string;
  userPool: IUserPool;
}

export function setupSlackHandler({
  slackLambda,
  approveRequestLambda,
  rejectRequestLambda,
  policyStoreArn,
  policyStoreId,
  appSettingsTable,
  accessRequestTableArn,
  accessRequestTableName,
  userPool,
}: SlackHandlerParams): void {
  slackLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [appSettingsTable.tableArn, accessRequestTableArn],
    })
  );

  // ListUsers resolves the approver's Cognito username (the Snitch::Approver principal).
  slackLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["cognito-idp:ListUsers"],
      resources: [userPool.userPoolArn],
    })
  );

  // Approver GROUP membership is resolved from IAM Identity Center (immutable IDC GroupIds),
  // never from Cognito user-pool groups — mirrors preTokenGenerationHandler (cognitoAuth.ts).
  slackLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["identitystore:ListUsers", "identitystore:ListGroupMembershipsForMember"],
      resources: ["*"],
    })
  );

  slackLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["verifiedpermissions:IsAuthorized"],
      resources: [policyStoreArn],
    })
  );

  slackLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["lambda:InvokeFunction"],
      resources: [approveRequestLambda.functionArn, rejectRequestLambda.functionArn],
    })
  );

  slackLambda.addEnvironment("APP_SETTINGS_TABLE_NAME", appSettingsTable.tableName);
  slackLambda.addEnvironment("ACCESS_REQUEST_TABLE_NAME", accessRequestTableName);
  slackLambda.addEnvironment("AUTH_USER_POOL_ID", userPool.userPoolId);
  slackLambda.addEnvironment("IDC_IDENTITY_STORE_ID", requireSynthEnv(process.env, "IDC_IDENTITY_STORE_ID"));
  slackLambda.addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
  slackLambda.addEnvironment("APPROVE_REQUEST_FUNCTION_ARN", approveRequestLambda.functionArn);
  slackLambda.addEnvironment("REJECT_REQUEST_FUNCTION_ARN", rejectRequestLambda.functionArn);

  // Auth is handled via HMAC signature verification in the handler itself.
  slackLambda.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    cors: { allowedOrigins: ["https://slack.com"] },
  });
}
