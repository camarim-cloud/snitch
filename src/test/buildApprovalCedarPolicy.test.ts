import { describe, expect, it } from "vitest";
import { buildApprovalCedarPolicy } from "../../amplify/functions/verifiedPermissions/buildApprovalCedarPolicy";

const ARN = "arn:aws:sso:::permissionSet/ssoins-abc/ps-12345";

describe("buildApprovalCedarPolicy", () => {
  it("USER principal uses == Snitch::Approver", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "alice",
      permissionSetArn: ARN,
    });
    expect(policy).toContain(`principal == Snitch::Approver::"alice"`);
    expect(policy).toContain(`action == Snitch::Action::"approve"`);
    expect(policy).toContain(`resource == Snitch::PermissionSet::"${ARN}"`);
    expect(policy).toMatch(/^permit \(/);
    expect(policy).toMatch(/\);$/);
  });

  it("GROUP principal uses in Snitch::ApproverGroup", () => {
    const policy = buildApprovalCedarPolicy({
      principalType: "GROUP",
      principalId: "Admins",
      permissionSetArn: ARN,
    });
    expect(policy).toContain(`principal in Snitch::ApproverGroup::"Admins"`);
    expect(policy).toContain(`action == Snitch::Action::"approve"`);
    expect(policy).toContain(`resource == Snitch::PermissionSet::"${ARN}"`);
  });

  it("embeds the full ARN as-is in the resource clause", () => {
    const longArn = "arn:aws:sso:::permissionSet/ssoins-xyz/ps-999";
    const policy = buildApprovalCedarPolicy({
      principalType: "USER",
      principalId: "bob",
      permissionSetArn: longArn,
    });
    expect(policy).toContain(`resource == Snitch::PermissionSet::"${longArn}"`);
  });

  it("different USER principals produce different policies", () => {
    const a = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", permissionSetArn: ARN });
    const b = buildApprovalCedarPolicy({ principalType: "USER", principalId: "bob", permissionSetArn: ARN });
    expect(a).not.toEqual(b);
  });

  it("different ARNs produce different policies", () => {
    const a = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", permissionSetArn: "arn:1" });
    const b = buildApprovalCedarPolicy({ principalType: "USER", principalId: "alice", permissionSetArn: "arn:2" });
    expect(a).not.toEqual(b);
  });
});
