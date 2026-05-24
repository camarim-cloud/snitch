import { defineBackend } from "@aws-amplify/backend";
import {
  CfnUserPoolDomain,
  CfnUserPoolIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { CfnPolicyStore } from "aws-cdk-lib/aws-verifiedpermissions";
import { RemovalPolicy, SecretValue, Stack } from "aws-cdk-lib";
import { outputDomainPrefix, outputCallbackUrl, outputIdentityStoreId, outputAdminGroupName } from "./authConfig";
import { setupAccessRequestWorkflow } from "./accessRequestWorkflow";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import {
  getMyIDCUserFunction,
  listIDCUsersFunction,
  listIDCGroupsFunction,
  listAWSAccountsFunction,
  listOUsFunction,
  listPermissionSetsFunction,
  listCognitoUsersFunction,
  listCognitoGroupsFunction,
} from "./functions/awsResources/resource";
import {
  createPrivilegedPolicyFunction,
  updatePrivilegedPolicyFunction,
  deletePrivilegedPolicyFunction,
  evaluateAccessFunction,
  createApprovalPolicyFunction,
  deleteApprovalPolicyFunction,
} from "./functions/verifiedPermissions/resource";
import {
  requestAccessFunction,
  listAccessRequestsFunction,
  assignPermissionSetFunction,
  removePermissionSetFunction,
  setStatusFailedFunction,
  storeApprovalTokenFunction,
  storeActiveTokenFunction,
  approveRequestFunction,
  rejectRequestFunction,
  listPendingApprovalsFunction,
  listAllAccessRequestsFunction,
  revokeAccessFunction,
  getCloudTrailLogsFunction,
} from "./functions/accessRequests/resource";
import {
  getSettingsFunction,
  updateSettingsFunction,
} from "./functions/settings/resource";
import { slackInteractiveFunction } from "./functions/slackInteractions/resource";
import { preTokenGenerationFunction } from "./functions/auth/resource";

const backend = defineBackend({
  auth,
  data,
  getMyIDCUserFunction,
  listIDCUsersFunction,
  listIDCGroupsFunction,
  listAWSAccountsFunction,
  listOUsFunction,
  listPermissionSetsFunction,
  listCognitoUsersFunction,
  listCognitoGroupsFunction,
  createPrivilegedPolicyFunction,
  updatePrivilegedPolicyFunction,
  deletePrivilegedPolicyFunction,
  evaluateAccessFunction,
  createApprovalPolicyFunction,
  deleteApprovalPolicyFunction,
  requestAccessFunction,
  listAccessRequestsFunction,
  assignPermissionSetFunction,
  removePermissionSetFunction,
  setStatusFailedFunction,
  storeApprovalTokenFunction,
  storeActiveTokenFunction,
  approveRequestFunction,
  rejectRequestFunction,
  listPendingApprovalsFunction,
  listAllAccessRequestsFunction,
  revokeAccessFunction,
  getCloudTrailLogsFunction,
  getSettingsFunction,
  updateSettingsFunction,
  slackInteractiveFunction,
  preTokenGenerationFunction,
});

const { userPool } = backend.auth.resources;

// ─── SAML / OAuth — all config sourced from Secrets Manager ──────────────────
// Values are CloudFormation dynamic references ({{resolve:secretsmanager:...}})
// resolved at deploy time. No environment variables are required.

const authStack = Stack.of(backend.auth.resources.cfnResources.cfnUserPool);
// Use the secret NAME (not ARN) in dynamic references. Amplify sandbox uses
// environment-agnostic nested stacks, so Secret.fromSecretNameV2 would embed
// ${AWS::Region}/${AWS::AccountId} pseudo-parameters inside the {{resolve:...}}
// string — CloudFormation cannot expand intrinsics there, causing ResourceNotFoundException.
// SecretValue.secretsManager with a literal name produces a static reference that works.
const metadataUrl  = SecretValue.secretsManager("snitch/auth-config", { jsonField: "IDC_SAML_METADATA_URL" }).unsafeUnwrap();

const samlProvider = new CfnUserPoolIdentityProvider(authStack, "IDCSAMLProvider", {
  userPoolId: userPool.userPoolId,
  providerName: "IDC",
  providerType: "SAML",
  providerDetails: {
    MetadataURL: metadataUrl,
    IDPSignout: "false",
  },
  attributeMapping: { email: "email" },
});

const { cfnUserPoolClient } = backend.auth.resources.cfnResources;
cfnUserPoolClient.allowedOAuthFlows = ["code"];
cfnUserPoolClient.allowedOAuthScopes = ["openid", "email", "profile"];
cfnUserPoolClient.allowedOAuthFlowsUserPoolClient = true;
cfnUserPoolClient.supportedIdentityProviders = ["IDC"];
cfnUserPoolClient.addDependency(samlProvider);


backend.addOutput({
  custom: {
    cognitoOAuthDomain: `${outputDomainPrefix}.auth.${authStack.region}.amazoncognito.com`,
    cognitoCallbackUrl: outputCallbackUrl,
  },
});

cfnUserPoolClient.callbackUrLs = [outputCallbackUrl, "http://localhost:5173"];
cfnUserPoolClient.logoutUrLs  = [outputCallbackUrl, "http://localhost:5173"];

new CfnUserPoolDomain(authStack, "CognitoDomain", {
  userPoolId: userPool.userPoolId,
  domain: outputDomainPrefix,
  managedLoginVersion: 2,

});

// ─── Pre-token generation Lambda — injects IDC groups into cognito:groups ────

backend.preTokenGenerationFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "identitystore:ListUsers",
      "identitystore:ListGroupMembershipsForMember",
      "identitystore:DescribeGroup",
    ],
    resources: ["*"],
  })
);
// IDC_IDENTITY_STORE_ID and ADMIN_GROUP_NAME are resolved from Secrets Manager at CDK
// synth time (via authConfig.ts) and embedded as plain strings in the Lambda env vars.
// This avoids both CloudFormation {{resolve:...}} limitations in nested-stack env vars
// and the need for a runtime secretsmanager:GetSecretValue IAM permission.
(backend.preTokenGenerationFunction.resources.lambda as LambdaFunction).addEnvironment(
  "IDC_IDENTITY_STORE_ID",
  outputIdentityStoreId
);
(backend.preTokenGenerationFunction.resources.lambda as LambdaFunction).addEnvironment(
  "ADMIN_GROUP_NAME",
  outputAdminGroupName
);

// ─── AWS resource Lambda permissions ─────────────────────────────────────────

const awsResourcePolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: [
    "sso:ListInstances",
    "sso:ListPermissionSets",
    "sso:DescribePermissionSet",
    "identitystore:ListUsers",
    "identitystore:ListGroups",
    "organizations:ListAccounts",
    "organizations:ListRoots",
    "organizations:ListOrganizationalUnitsForParent",
  ],
  resources: ["*"],
});

for (const fn of [
  backend.getMyIDCUserFunction,
  backend.listIDCUsersFunction,
  backend.listIDCGroupsFunction,
  backend.listAWSAccountsFunction,
  backend.listOUsFunction,
  backend.listPermissionSetsFunction,
]) {
  fn.resources.lambda.addToRolePolicy(awsResourcePolicy);
}


const cognitoListPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["cognito-idp:ListUsers", "cognito-idp:ListGroups"],
  resources: [userPool.userPoolArn],
});

for (const fn of [
  backend.listCognitoUsersFunction,
  backend.listCognitoGroupsFunction,
]) {
  fn.resources.lambda.addToRolePolicy(cognitoListPolicy);
  (fn.resources.lambda as LambdaFunction).addEnvironment(
    "AUTH_USER_POOL_ID",
    userPool.userPoolId
  );
}

// ─── Verified Permissions policy store ───────────────────────────────────────

// Cedar schema for the Snitch namespace:
//   assume — principal: User (IDC) | Group (IDC); resource: Account | OU; context: permissionSetArn
//   approve — principal: Approver (Cognito username) | ApproverGroup (Cognito group name);
//             resource: Account (AWS account ID); context: permissionSetArn (enforced in `when` clause)
const cedarSchema = {
  Snitch: {
    entityTypes: {
      User: { memberOfTypes: ["Group"] },
      Group: { memberOfTypes: [] },
      Account: { memberOfTypes: ["OU"] },
      OU: { memberOfTypes: ["OU"] },
      Approver: { memberOfTypes: ["ApproverGroup"] },
      ApproverGroup: { memberOfTypes: [] },
    },
    actions: {
      assume: {
        appliesTo: {
          principalTypes: ["User", "Group"],
          resourceTypes: ["Account", "OU"],
          context: {
            type: "Record",
            attributes: {
              permissionSetArn: { type: "String", required: true },
            },
          },
        },
      },
      approve: {
        appliesTo: {
          principalTypes: ["Approver", "ApproverGroup"],
          resourceTypes: ["Account"],
          context: {
            type: "Record",
            attributes: {
              permissionSetArn: { type: "String", required: true },
            },
          },
        },
      },
    },
  },
};

// Scoped to the PrivilegedPolicy DynamoDB table so it lives in the data stack.
const policyStore = new CfnPolicyStore(
  backend.data.resources.tables["PrivilegedPolicy"],
  "PrivilegedPolicyStore",
  {
    validationSettings: { mode: "STRICT" },
    schema: { cedarJson: JSON.stringify(cedarSchema) },
    description: "Stores Cedar policies that authorise IDC principals to access AWS accounts",
  }
);

const policyStoreArn = policyStore.attrArn;
const policyStoreId = policyStore.attrPolicyStoreId;

const avpPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: [
    "verifiedpermissions:CreatePolicy",
    "verifiedpermissions:UpdatePolicy",
    "verifiedpermissions:DeletePolicy",
  ],
  resources: [policyStoreArn],
});

const privilegedPolicyTable = backend.data.resources.tables["PrivilegedPolicy"];

const privilegedPolicyDdbPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
  ],
  resources: [privilegedPolicyTable.tableArn],
});

const conflictCheckDdbPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["dynamodb:Scan"],
  resources: [privilegedPolicyTable.tableArn],
});

for (const fn of [
  backend.createPrivilegedPolicyFunction,
  backend.updatePrivilegedPolicyFunction,
  backend.deletePrivilegedPolicyFunction,
]) {
  fn.resources.lambda.addToRolePolicy(avpPolicy);
  fn.resources.lambda.addToRolePolicy(privilegedPolicyDdbPolicy);
  (fn.resources.lambda as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
  (fn.resources.lambda as LambdaFunction).addEnvironment(
    "PRIVILEGED_POLICY_TABLE_NAME",
    privilegedPolicyTable.tableName
  );
}

for (const fn of [
  backend.createPrivilegedPolicyFunction,
  backend.updatePrivilegedPolicyFunction,
]) {
  fn.resources.lambda.addToRolePolicy(conflictCheckDdbPolicy);
}

// ─── Approval policy handlers ─────────────────────────────────────────────────

const approvalPolicyTable = backend.data.resources.tables["ApprovalPolicy"];

const approvalPolicyDdbPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
  resources: [approvalPolicyTable.tableArn],
});

const avpCreateDeletePolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["verifiedpermissions:CreatePolicy", "verifiedpermissions:DeletePolicy"],
  resources: [policyStoreArn],
});

for (const fn of [
  backend.createApprovalPolicyFunction,
  backend.deleteApprovalPolicyFunction,
]) {
  fn.resources.lambda.addToRolePolicy(avpCreateDeletePolicy);
  fn.resources.lambda.addToRolePolicy(approvalPolicyDdbPolicy);
  (fn.resources.lambda as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
  (fn.resources.lambda as LambdaFunction).addEnvironment(
    "APPROVAL_POLICY_TABLE_NAME",
    approvalPolicyTable.tableName
  );
}

backend.evaluateAccessFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["verifiedpermissions:IsAuthorized"],
    resources: [policyStoreArn],
  })
);
backend.evaluateAccessFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:Scan"],
    resources: [privilegedPolicyTable.tableArn],
  })
);
backend.evaluateAccessFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "sso:ListInstances",
      "identitystore:ListUsers",
      "identitystore:ListGroupMembershipsForMember",
    ],
    resources: ["*"],
  })
);
(backend.evaluateAccessFunction.resources.lambda as LambdaFunction).addEnvironment(
  "AVP_POLICY_STORE_ID",
  policyStoreId
);
(backend.evaluateAccessFunction.resources.lambda as LambdaFunction).addEnvironment(
  "PRIVILEGED_POLICY_TABLE_NAME",
  privilegedPolicyTable.tableName
);

// ─── Access Request workflow ──────────────────────────────────────────────────

const { accessRequestTableArn, accessRequestTableName } = setupAccessRequestWorkflow(backend);

// approveRequest, rejectRequest, listPendingApprovals live in the data stack
// (resourceGroupName: "data") so AppSync can resolve them without creating a
// circular dependency. Their grants are set here where both table references
// are available in the same scope.

const accessRequestApprovalDdbPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Scan"],
  resources: [accessRequestTableArn],
});

const avpIsAuthorizedPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  actions: ["verifiedpermissions:IsAuthorized"],
  resources: [policyStoreArn],
});

const sendTaskPolicy = new PolicyStatement({
  effect: Effect.ALLOW,
  // SendTask* APIs do not support resource-level restrictions
  actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
  resources: ["*"],
});

for (const fn of [
  backend.approveRequestFunction,
  backend.rejectRequestFunction,
]) {
  fn.resources.lambda.addToRolePolicy(accessRequestApprovalDdbPolicy);
  fn.resources.lambda.addToRolePolicy(avpIsAuthorizedPolicy);
  fn.resources.lambda.addToRolePolicy(sendTaskPolicy);
  (fn.resources.lambda as LambdaFunction).addEnvironment(
    "ACCESS_REQUEST_TABLE_NAME",
    accessRequestTableName
  );
  (fn.resources.lambda as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
}

backend.listPendingApprovalsFunction.resources.lambda.addToRolePolicy(
  accessRequestApprovalDdbPolicy
);
backend.listPendingApprovalsFunction.resources.lambda.addToRolePolicy(avpIsAuthorizedPolicy);
(backend.listPendingApprovalsFunction.resources.lambda as LambdaFunction).addEnvironment(
  "ACCESS_REQUEST_TABLE_NAME",
  accessRequestTableName
);
(backend.listPendingApprovalsFunction.resources.lambda as LambdaFunction).addEnvironment(
  "AVP_POLICY_STORE_ID",
  policyStoreId
);

backend.listAllAccessRequestsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:Scan"],
    resources: [accessRequestTableArn],
  })
);
(backend.listAllAccessRequestsFunction.resources.lambda as LambdaFunction).addEnvironment(
  "ACCESS_REQUEST_TABLE_NAME",
  accessRequestTableName
);

backend.revokeAccessFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
    resources: [accessRequestTableArn],
  })
);
// SendTaskSuccess does not support resource-level restrictions (same constraint as sendTaskPolicy)
backend.revokeAccessFunction.resources.lambda.addToRolePolicy(sendTaskPolicy);
(backend.revokeAccessFunction.resources.lambda as LambdaFunction).addEnvironment(
  "ACCESS_REQUEST_TABLE_NAME",
  accessRequestTableName
);

// ─── App Settings table ───────────────────────────────────────────────────────

const settingsStack = backend.createStack("AppSettingsStack");
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

for (const fn of [backend.getSettingsFunction, backend.updateSettingsFunction]) {
  fn.resources.lambda.addToRolePolicy(settingsDdbPolicy);
  (fn.resources.lambda as LambdaFunction).addEnvironment(
    "APP_SETTINGS_TABLE_NAME",
    appSettingsTable.tableName
  );
}

// CloudTrail log reader: reads settings to get the log group, then queries CloudWatch Logs.
backend.getCloudTrailLogsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem"],
    resources: [appSettingsTable.tableArn],
  })
);
backend.getCloudTrailLogsFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    // Scoped to the logs service; the specific log group is determined at runtime
    // from AppSettingsTable so we cannot scope to a fixed resource ARN here.
    actions: ["logs:FilterLogEvents"],
    resources: ["*"],
  })
);
(backend.getCloudTrailLogsFunction.resources.lambda as LambdaFunction).addEnvironment(
  "APP_SETTINGS_TABLE_NAME",
  appSettingsTable.tableName
);

// storeApprovalToken: reads the request + settings to send Slack notification.
backend.storeApprovalTokenFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem"],
    resources: [accessRequestTableArn, appSettingsTable.tableArn],
  })
);
(backend.storeApprovalTokenFunction.resources.lambda as LambdaFunction).addEnvironment(
  "APP_SETTINGS_TABLE_NAME",
  appSettingsTable.tableName
);

// ─── Slack interactive handler ────────────────────────────────────────────────

const slackLambda = backend.slackInteractiveFunction.resources.lambda as LambdaFunction;

slackLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem"],
    resources: [appSettingsTable.tableArn, accessRequestTableArn],
  })
);

slackLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "cognito-idp:ListUsers",
      "cognito-idp:AdminListGroupsForUser",
    ],
    resources: [userPool.userPoolArn],
  })
);

slackLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["verifiedpermissions:IsAuthorized"],
    resources: [policyStoreArn],
  })
);

const approveRequestLambda = backend.approveRequestFunction.resources.lambda as LambdaFunction;
const rejectRequestLambda = backend.rejectRequestFunction.resources.lambda as LambdaFunction;

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
slackLambda.addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
slackLambda.addEnvironment("APPROVE_REQUEST_FUNCTION_ARN", approveRequestLambda.functionArn);
slackLambda.addEnvironment("REJECT_REQUEST_FUNCTION_ARN", rejectRequestLambda.functionArn);

// Public HTTP endpoint for Slack to call back — auth is handled via HMAC signature verification.
slackLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  cors: { allowedOrigins: ["https://slack.com"] },
});
