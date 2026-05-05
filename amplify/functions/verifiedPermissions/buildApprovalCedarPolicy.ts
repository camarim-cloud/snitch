type ApprovalPolicyInput = {
  principalType: "USER" | "GROUP";
  principalId: string;
  accountId: string;
  permissionSetArns: string[]; // at least 1 required
};

/**
 * Builds a Cedar PERMIT statement for the `approve` action.
 * Resource is the AWS account; permission set ARNs are enforced in the `when` clause.
 *
 * USER  → `principal == Snitch::Approver::"<cognito-username>"`
 * GROUP → `principal in Snitch::ApproverGroup::"<cognito-group>"`
 *
 * Example (USER):
 *   buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: "111111111111", permissionSetArns: ["arn:...ps-1"] })
 */
export function buildApprovalCedarPolicy(input: ApprovalPolicyInput): string {
  const { principalType, principalId, accountId, permissionSetArns } = input;

  const principalClause =
    principalType === "USER"
      ? `principal == Snitch::Approver::"${principalId}"`
      : `principal in Snitch::ApproverGroup::"${principalId}"`;

  const arnList = permissionSetArns.map((a) => `"${a}"`).join(", ");

  return (
    `permit (\n` +
    `  ${principalClause},\n` +
    `  action == Snitch::Action::"approve",\n` +
    `  resource == Snitch::Account::"${accountId}"\n` +
    `) when {\n` +
    `  [${arnList}].contains(context.permissionSetArn)\n` +
    `};`
  );
}
