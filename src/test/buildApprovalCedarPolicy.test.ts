import { describe, expect, it } from "vitest";
import { buildApprovalCedarPolicy } from "../../amplify/functions/verifiedPermissions/buildApprovalCedarPolicy";

const ACCOUNT = "111111111111";
const ARN1 = "arn:aws:sso:::permissionSet/ssoins-abc/ps-12345";
const ARN2 = "arn:aws:sso:::permissionSet/ssoins-abc/ps-99999";

describe("buildApprovalCedarPolicy", () => {
  it("USER principal uses == Snitch::Approver with Account resource", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "alice",
      accountId: ACCOUNT,
      permissionSetArns: [ARN1],
    });
    expect(policy).toContain(`principal == Snitch::Approver::"alice"`);
    expect(policy).toContain(`action == Snitch::Action::"approve"`);
    expect(policy).toContain(`resource == Snitch::Account::"${ACCOUNT}"`);
    expect(policy).toMatch(/^permit \(/);
    expect(policy).toMatch(/\};$/);
  });

  it("GROUP principal uses in Snitch::ApproverGroup", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "GROUP",
      principalId: "Admins",
      accountId: ACCOUNT,
      permissionSetArns: [ARN1],
    });
    expect(policy).toContain(`principal in Snitch::ApproverGroup::"Admins"`);
    expect(policy).toContain(`resource == Snitch::Account::"${ACCOUNT}"`);
  });

  it("single ARN appears in the when clause", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "alice",
      accountId: ACCOUNT,
      permissionSetArns: [ARN1],
    });
    expect(policy).toContain(`"${ARN1}"`);
    expect(policy).toContain(`contains(context.permissionSetArn)`);
  });

  it("multiple ARNs all appear in the when clause list", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "alice",
      accountId: ACCOUNT,
      permissionSetArns: [ARN1, ARN2],
    });
    expect(policy).toContain(`"${ARN1}"`);
    expect(policy).toContain(`"${ARN2}"`);
    expect(policy).toContain(`contains(context.permissionSetArn)`);
  });

  it("different accounts produce different policies", () => {
    const a = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: "111", permissionSetArns: [ARN1] });
    const b = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: "222", permissionSetArns: [ARN1] });
    expect(a).not.toEqual(b);
  });

  it("different ARN lists produce different policies", () => {
    const a = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: ACCOUNT, permissionSetArns: [ARN1] });
    const b = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: ACCOUNT, permissionSetArns: [ARN2] });
    expect(a).not.toEqual(b);
  });

  it("different USER principals produce different policies", () => {
    const a = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", accountId: ACCOUNT, permissionSetArns: [ARN1] });
    const b = buildApprovalCedarPolicy({ principalType: "USER", principalId: "bob", accountId: ACCOUNT, permissionSetArns: [ARN1] });
    expect(a).not.toEqual(b);
  });

  it("does not reference Snitch::PermissionSet as resource", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "alice",
      accountId: ACCOUNT,
      permissionSetArns: [ARN1],
    });
    expect(policy).not.toContain("Snitch::PermissionSet");
  });
});
