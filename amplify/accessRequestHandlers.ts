import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, IFunction } from "aws-cdk-lib/aws-lambda";

interface AccessRequestHandlerParams {
  accessRequestTableArn: string;
  accessRequestTableName: string;
  policyStoreArn: string;
  policyStoreId: string;
  approveRequestFn: IFunction;
  rejectRequestFn: IFunction;
  listPendingApprovalsFn: IFunction;
  listAllAccessRequestsFn: IFunction;
  revokeAccessFn: IFunction;
}

export function setupAccessRequestHandlers({
  accessRequestTableArn,
  accessRequestTableName,
  policyStoreArn,
  policyStoreId,
  approveRequestFn,
  rejectRequestFn,
  listPendingApprovalsFn,
  listAllAccessRequestsFn,
  revokeAccessFn,
}: AccessRequestHandlerParams): void {
  const approvalDdbPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Scan"],
    resources: [accessRequestTableArn],
  });

  const avpIsAuthorizedPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["verifiedpermissions:IsAuthorized"],
    resources: [policyStoreArn],
  });

  // SendTask* APIs do not support resource-level restrictions.
  const sendTaskPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
    resources: ["*"],
  });

  for (const fn of [approveRequestFn, rejectRequestFn]) {
    fn.addToRolePolicy(approvalDdbPolicy);
    fn.addToRolePolicy(avpIsAuthorizedPolicy);
    fn.addToRolePolicy(sendTaskPolicy);
    (fn as LambdaFunction).addEnvironment("ACCESS_REQUEST_TABLE_NAME", accessRequestTableName);
    (fn as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);
  }

  listPendingApprovalsFn.addToRolePolicy(approvalDdbPolicy);
  listPendingApprovalsFn.addToRolePolicy(avpIsAuthorizedPolicy);
  (listPendingApprovalsFn as LambdaFunction).addEnvironment(
    "ACCESS_REQUEST_TABLE_NAME",
    accessRequestTableName
  );
  (listPendingApprovalsFn as LambdaFunction).addEnvironment("AVP_POLICY_STORE_ID", policyStoreId);

  listAllAccessRequestsFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:Scan"],
      resources: [accessRequestTableArn],
    })
  );
  (listAllAccessRequestsFn as LambdaFunction).addEnvironment(
    "ACCESS_REQUEST_TABLE_NAME",
    accessRequestTableName
  );

  revokeAccessFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [accessRequestTableArn],
    })
  );
  revokeAccessFn.addToRolePolicy(sendTaskPolicy);
  (revokeAccessFn as LambdaFunction).addEnvironment(
    "ACCESS_REQUEST_TABLE_NAME",
    accessRequestTableName
  );
}
