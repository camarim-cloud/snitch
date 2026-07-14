import { defineBackend } from "@aws-amplify/backend";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Stack } from "aws-cdk-lib";
import { setupAccessRequestWorkflow } from "./accessRequestWorkflow";
import { setupCognitoAuth } from "./cognitoAuth";
import { setupAWSResourceFunctions } from "./awsResourceFunctions";
import { setupPolicyStore } from "./policyStore";
import { setupAppSettings } from "./appSettings";
import { setupAccessRequestHandlers } from "./accessRequestHandlers";
import { setupSlackHandler } from "./slackHandler";
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
import { getSettingsFunction, updateSettingsFunction } from "./functions/settings/resource";
import { slackInteractiveFunction } from "./functions/slackInteractions/resource";
import { preTokenGenerationFunction } from "./functions/auth/resource";

function requireSynthEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for synth-time Cognito config.`);
  }
  return value;
}

const outputDomainPrefix = requireSynthEnv("COGNITO_DOMAIN_PREFIX");
const outputCallbackUrl = requireSynthEnv("APP_CALLBACK_URL");

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

const { userPool, cfnResources } = backend.auth.resources;
const authStack = Stack.of(cfnResources.cfnUserPool);

backend.addOutput({
  custom: {
    cognitoOAuthDomain: `${outputDomainPrefix}.auth.${authStack.region}.amazoncognito.com`,
    cognitoCallbackUrl: outputCallbackUrl,
  },
});

setupCognitoAuth({
  userPool,
  cfnUserPool: cfnResources.cfnUserPool,
  cfnUserPoolClient: cfnResources.cfnUserPoolClient,
  preTokenLambda: backend.preTokenGenerationFunction.resources.lambda as LambdaFunction,
});

setupAWSResourceFunctions({
  userPool,
  idcFunctions: [
    backend.getMyIDCUserFunction.resources.lambda,
    backend.listIDCUsersFunction.resources.lambda,
    backend.listIDCGroupsFunction.resources.lambda,
    backend.listAWSAccountsFunction.resources.lambda,
    backend.listOUsFunction.resources.lambda,
    backend.listPermissionSetsFunction.resources.lambda,
  ],
  cognitoFunctions: [
    backend.listCognitoUsersFunction.resources.lambda,
  ],
});

const { policyStoreArn, policyStoreId } = setupPolicyStore({
  privilegedPolicyTable: backend.data.resources.tables["PrivilegedPolicy"] as Table,
  approvalPolicyTable: backend.data.resources.tables["ApprovalPolicy"],
  createPrivilegedPolicyFn: backend.createPrivilegedPolicyFunction.resources.lambda,
  updatePrivilegedPolicyFn: backend.updatePrivilegedPolicyFunction.resources.lambda,
  deletePrivilegedPolicyFn: backend.deletePrivilegedPolicyFunction.resources.lambda,
  createApprovalPolicyFn: backend.createApprovalPolicyFunction.resources.lambda,
  deleteApprovalPolicyFn: backend.deleteApprovalPolicyFunction.resources.lambda,
  evaluateAccessFn: backend.evaluateAccessFunction.resources.lambda,
});

const { accessRequestTableArn, accessRequestTableName, notificationsTopicArn } =
  setupAccessRequestWorkflow(backend);

const appSettingsTable = setupAppSettings({
  settingsStack: backend.createStack("AppSettingsStack"),
  getSettingsFn: backend.getSettingsFunction.resources.lambda,
  updateSettingsFn: backend.updateSettingsFunction.resources.lambda,
  getCloudTrailLogsFn: backend.getCloudTrailLogsFunction.resources.lambda,
  storeApprovalTokenFn: backend.storeApprovalTokenFunction.resources.lambda,
  requestAccessFn: backend.requestAccessFunction.resources.lambda,
  removePermissionSetFn: backend.removePermissionSetFunction.resources.lambda,
  accessRequestTableArn,
  notificationsTopicArn,
});

// The SNS approval notification links back to the in-app Approve Requests page.
(backend.storeApprovalTokenFunction.resources.lambda as LambdaFunction).addEnvironment(
  "APP_CALLBACK_URL",
  outputCallbackUrl
);

setupAccessRequestHandlers({
  accessRequestTableArn,
  accessRequestTableName,
  policyStoreArn,
  policyStoreId,
  approveRequestFn: backend.approveRequestFunction.resources.lambda,
  rejectRequestFn: backend.rejectRequestFunction.resources.lambda,
  listPendingApprovalsFn: backend.listPendingApprovalsFunction.resources.lambda,
  listAllAccessRequestsFn: backend.listAllAccessRequestsFunction.resources.lambda,
  revokeAccessFn: backend.revokeAccessFunction.resources.lambda,
});

setupSlackHandler({
  slackLambda: backend.slackInteractiveFunction.resources.lambda as LambdaFunction,
  approveRequestLambda: backend.approveRequestFunction.resources.lambda as LambdaFunction,
  rejectRequestLambda: backend.rejectRequestFunction.resources.lambda as LambdaFunction,
  policyStoreArn,
  policyStoreId,
  appSettingsTable,
  accessRequestTableArn,
  accessRequestTableName,
  userPool,
});
