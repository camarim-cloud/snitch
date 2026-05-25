import { CfnPolicyStore } from "aws-cdk-lib/aws-verifiedpermissions";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, IFunction } from "aws-cdk-lib/aws-lambda";
import { ITable, Table } from "aws-cdk-lib/aws-dynamodb";

// Cedar schema: assume (IDC principals → AWS accounts/OUs) and
// approve (Cognito principals → AWS accounts, permissionSetArn in context).
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
            attributes: { permissionSetArn: { type: "String", required: true } },
          },
        },
      },
      approve: {
        appliesTo: {
          principalTypes: ["Approver", "ApproverGroup"],
          resourceTypes: ["Account"],
          context: {
            type: "Record",
            attributes: { permissionSetArn: { type: "String", required: true } },
          },
        },
      },
    },
  },
};

interface PolicyStoreParams {
  // Table is used both as the CDK construct scope for CfnPolicyStore and as an ITable.
  privilegedPolicyTable: Table;
  approvalPolicyTable: ITable;
  createPrivilegedPolicyFn: IFunction;
  updatePrivilegedPolicyFn: IFunction;
  deletePrivilegedPolicyFn: IFunction;
  createApprovalPolicyFn: IFunction;
  deleteApprovalPolicyFn: IFunction;
  evaluateAccessFn: IFunction;
}

export interface PolicyStoreOutputs {
  policyStoreArn: string;
  policyStoreId: string;
}

export function setupPolicyStore({
  privilegedPolicyTable,
  approvalPolicyTable,
  createPrivilegedPolicyFn,
  updatePrivilegedPolicyFn,
  deletePrivilegedPolicyFn,
  createApprovalPolicyFn,
  deleteApprovalPolicyFn,
  evaluateAccessFn,
}: PolicyStoreParams): PolicyStoreOutputs {
  const policyStore = new CfnPolicyStore(privilegedPolicyTable, "PrivilegedPolicyStore", {
    validationSettings: { mode: "STRICT" },
    schema: { cedarJson: JSON.stringify(cedarSchema) },
    description: "Stores Cedar policies that authorise IDC principals to access AWS accounts",
  });

  const policyStoreArn = policyStore.attrArn;
  const policyStoreId = policyStore.attrPolicyStoreId;

  const avpCrudPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "verifiedpermissions:CreatePolicy",
      "verifiedpermissions:UpdatePolicy",
      "verifiedpermissions:DeletePolicy",
    ],
    resources: [policyStoreArn],
  });

  const privilegedDdbCrudPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
    resources: [privilegedPolicyTable.tableArn],
  });

  const conflictCheckDdbPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:Scan"],
    resources: [privilegedPolicyTable.tableArn],
  });

  const privilegedCrudFns = [createPrivilegedPolicyFn, updatePrivilegedPolicyFn, deletePrivilegedPolicyFn];
  for (const fn of privilegedCrudFns) {
    fn.addToRolePolicy(avpCrudPolicy);
    fn.addToRolePolicy(privilegedDdbCrudPolicy);
    (fn as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
    (fn as LambdaFunction).addEnvironment("PRIVILEGED_POLICY_TABLE_NAME", privilegedPolicyTable.tableName);
  }

  for (const fn of [createPrivilegedPolicyFn, updatePrivilegedPolicyFn]) {
    fn.addToRolePolicy(conflictCheckDdbPolicy);
  }

  const avpCreateDeletePolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["verifiedpermissions:CreatePolicy", "verifiedpermissions:DeletePolicy"],
    resources: [policyStoreArn],
  });

  const approvalDdbPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
    resources: [approvalPolicyTable.tableArn],
  });

  for (const fn of [createApprovalPolicyFn, deleteApprovalPolicyFn]) {
    fn.addToRolePolicy(avpCreateDeletePolicy);
    fn.addToRolePolicy(approvalDdbPolicy);
    (fn as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
    (fn as LambdaFunction).addEnvironment("APPROVAL_POLICY_TABLE_NAME", approvalPolicyTable.tableName);
  }

  evaluateAccessFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["verifiedpermissions:IsAuthorized"],
      resources: [policyStoreArn],
    })
  );
  evaluateAccessFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:Scan"],
      resources: [privilegedPolicyTable.tableArn],
    })
  );
  evaluateAccessFn.addToRolePolicy(
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
  (evaluateAccessFn as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
  (evaluateAccessFn as LambdaFunction).addEnvironment(
    "PRIVILEGED_POLICY_TABLE_NAME",
    privilegedPolicyTable.tableName
  );

  return { policyStoreArn, policyStoreId };
}
