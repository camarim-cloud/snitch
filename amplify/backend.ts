import { defineBackend } from "@aws-amplify/backend";
import { CfnUserPoolGroup } from "aws-cdk-lib/aws-cognito";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { CfnPolicyStore } from "aws-cdk-lib/aws-verifiedpermissions";
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
} from "./functions/accessRequests/resource";

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
});

// ─── Cognito Admins group ─────────────────────────────────────────────────────

const { userPool } = backend.auth.resources;
new CfnUserPoolGroup(userPool, "AdminsGroup", {
  userPoolId: userPool.userPoolId,
  groupName: "Admins",
  description: "Administrators with access to privileged policies",
});

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

// getMyIDCUser additionally needs to look up the Cognito user by sub to
// retrieve the email attribute — required because AppSync may forward the
// access token (which has no email claim) instead of the ID token.
backend.getMyIDCUserFunction.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["cognito-idp:AdminGetUser"],
    resources: [userPool.userPoolArn],
  })
);
(backend.getMyIDCUserFunction.resources.lambda as LambdaFunction).addEnvironment(
  "AUTH_USER_POOL_ID",
  userPool.userPoolId
);

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
//             resource: PermissionSet (ARN); no context required
const cedarSchema = {
  Snitch: {
    entityTypes: {
      User: { memberOfTypes: ["Group"] },
      Group: { memberOfTypes: [] },
      Account: { memberOfTypes: ["OU"] },
      OU: { memberOfTypes: ["OU"] },
      Approver: { memberOfTypes: ["ApproverGroup"] },
      ApproverGroup: { memberOfTypes: [] },
      PermissionSet: { memberOfTypes: [] },
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
          resourceTypes: ["PermissionSet"],
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
  actions: ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:GetItem"],
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
