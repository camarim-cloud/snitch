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

const identitystore = new IdentitystoreClient({ region: REGION });

export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  const email = event.request.userAttributes["email"];
  if (!email) return event;

  // Find IDC user by email (IdentityStore uses UserName = email for IDC-managed users)
  const listResult = await identitystore.send(
    new ListUsersCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      Filters: [{ AttributePath: "UserName", AttributeValue: email }],
    })
  );
  const idcUserId = listResult.Users?.[0]?.UserId;
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

  // "Admins" is added when the user belongs to the configured IDC admin group so that
  // Cognito's allow.group("Admins") authorization rules continue to work unchanged.
  const cognitoGroups = groupNames.includes(ADMIN_GROUP_NAME)
    ? [...groupNames, "Admins"]
    : groupNames;

  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: { groupsToOverride: cognitoGroups },
    },
  };
  return event;
};
