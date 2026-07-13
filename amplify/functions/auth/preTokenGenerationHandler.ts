import type { PreTokenGenerationV2TriggerHandler } from "aws-lambda";
import {
  IdentitystoreClient,
  type GroupMembership,
  ListUsersCommand,
  ListGroupMembershipsForMemberCommand,
  DescribeGroupCommand,
} from "@aws-sdk/client-identitystore";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const IDENTITY_STORE_ID = process.env.IDC_IDENTITY_STORE_ID!;
const ADMIN_GROUP_NAME = process.env.ADMIN_GROUP_NAME!;
const AUDITOR_GROUP_NAME = process.env.AUDITOR_GROUP_NAME!;

const identitystore = new IdentitystoreClient({ region: REGION });

const IDC_USERNAME_PREFIX = "idc_";

export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  // For SAML-federated IDC users, userAttributes["email"] may be absent if IDC
  // doesn't send the email as a separate SAML attribute. The Cognito username is
  // always set to "idc_<samlNameId>" where the NameID is the user's email, so we
  // fall back to stripping that prefix (same pattern as getMyIDCUserHandler).
  const email =
    event.request.userAttributes["email"] ||
    (event.userName.startsWith(IDC_USERNAME_PREFIX)
      ? event.userName.slice(IDC_USERNAME_PREFIX.length)
      : undefined);

  console.log(JSON.stringify({ msg: "pre-token-generation", userName: event.userName, email: email ?? null }));

  if (!email) return event;

  // Find IDC user by email (IdentityStore uses UserName = email for IDC-managed users)
  const listResult = await identitystore.send(
    new ListUsersCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      Filters: [{ AttributePath: "UserName", AttributeValue: email }],
    })
  );
  const idcUserId = listResult.Users?.[0]?.UserId;
  console.log(JSON.stringify({ msg: "idc-lookup", email, idcUserId: idcUserId ?? null }));
  if (!idcUserId) return event;

  const memberships = await identitystore.send(
    new ListGroupMembershipsForMemberCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      MemberId: { UserId: idcUserId },
    })
  );

  const groupNames = await Promise.all(
    (memberships.GroupMemberships ?? []).map(async (m: GroupMembership) => {
      const group = await identitystore.send(
        new DescribeGroupCommand({
          IdentityStoreId: IDENTITY_STORE_ID,
          GroupId: m.GroupId!,
        })
      );
      return group.DisplayName ?? m.GroupId!;
    })
  );

  // The literal "Admins"/"Auditors" claims are appended when the user belongs to the
  // configured IDC group for each role, so Cognito's allow.group("Admins") /
  // allow.groups(["Admins","Auditors"]) authorization rules resolve unchanged. A user
  // in both IDC groups correctly receives both claims.
  const cognitoGroups = [...groupNames];
  if (groupNames.includes(ADMIN_GROUP_NAME)) cognitoGroups.push("Admins");
  if (groupNames.includes(AUDITOR_GROUP_NAME)) cognitoGroups.push("Auditors");

  console.log(
    JSON.stringify({ msg: "groups-resolved", ADMIN_GROUP_NAME, AUDITOR_GROUP_NAME, groupNames, cognitoGroups })
  );

  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: { groupsToOverride: cognitoGroups },
    },
  };
  return event;
};
