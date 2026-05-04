type ApprovalPolicyInput = {
  principalType: "USER" | "GROUP";
  principalId: string;
  permissionSetArn: string;
};

/**
 * Builds a Cedar PERMIT statement for the `approve` action.
 *
 * USER  → `principal == Snitch::Approver::"<cognito-username>"`
 * GROUP → `principal in Snitch::ApproverGroup::"<cognito-group>"`
 *
 * Example (USER):
 *   buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", permissionSetArn: "arn:aws:sso:::permissionSet/ps-1" })
 */
export function buildApprovalCedarPolicy(input: ApprovalPolicyInput): string {
  const { principalType, principalId, permissionSetArn } = input;

  const principalClause =
    principalType === "USER"
      ? `principal == Snitch::Approver::"${principalId}"`
      : `principal in Snitch::ApproverGroup::"${principalId}"`;

  return (
    `permit (\n` +
    `  ${principalClause},\n` +
    `  action == Snitch::Action::"approve",\n` +
    `  resource == Snitch::PermissionSet::"${permissionSetArn}"\n` +
    `);`
  );
}
