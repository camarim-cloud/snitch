import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import {
  getMyIDCUserFunction,
  listIDCUsersFunction,
  listIDCGroupsFunction,
  listAWSAccountsFunction,
  listOUsFunction,
  listPermissionSetsFunction,
  listCognitoUsersFunction,
  listCognitoGroupsFunction,
} from "../functions/awsResources/resource";
import {
  createPrivilegedPolicyFunction,
  updatePrivilegedPolicyFunction,
  deletePrivilegedPolicyFunction,
  evaluateAccessFunction,
  createApprovalPolicyFunction,
  deleteApprovalPolicyFunction,
} from "../functions/verifiedPermissions/resource";
import {
  requestAccessFunction,
  listAccessRequestsFunction,
  approveRequestFunction,
  rejectRequestFunction,
  listPendingApprovalsFunction,
  listAllAccessRequestsFunction,
  revokeAccessFunction,
  getCloudTrailLogsFunction,
} from "../functions/accessRequests/resource";
import {
  getSettingsFunction,
  updateSettingsFunction,
} from "../functions/settings/resource";

const schema = a.schema({
  PrincipalType: a.enum(["USER", "GROUP"]),

  PrivilegedPolicy: a
    .model({
      name: a.string().required(),
      description: a.string(),
      principalType: a.ref("PrincipalType"),
      principalId: a.string().required(),
      principalDisplayName: a.string(),
      accountIds: a.string().array(),
      ouIds: a.string().array(),
      permissionSetArns: a.string().array(),
      permissionSetNames: a.string().array(),
      maxDurationMinutes: a.integer(),
      avpPolicyId: a.string(),
      requiresApproval: a.boolean(),
    })
    .authorization((allow) => [allow.group("Admins")]),

  // Hash key: accountId, sort key: principalKey ("${principalType}#${principalId}").
  // The composite primary key enables O(1) GetItem duplicate checks with no GSI or scan.
  ApprovalPolicy: a
    .model({
      accountId: a.string().required(),
      principalKey: a.string().required(),
      accountName: a.string(),
      principalType: a.ref("PrincipalType"),
      principalId: a.string(),
      principalDisplayName: a.string(),
      permissionSetArns: a.string().array(),
      permissionSetNames: a.string().array(),
      avpPolicyId: a.string(),
    })
    .identifier(["accountId", "principalKey"])
    .authorization((allow) => [allow.group("Admins")]),

  // Custom types returned by Lambda queries
  IDCUser: a.customType({
    id: a.string(),
    userName: a.string(),
    displayName: a.string(),
    email: a.string(),
  }),

  IDCGroup: a.customType({
    id: a.string(),
    displayName: a.string(),
    description: a.string(),
  }),

  AWSAccount: a.customType({
    id: a.string(),
    name: a.string(),
    email: a.string(),
    status: a.string(),
  }),

  OrganizationalUnit: a.customType({
    id: a.string(),
    name: a.string(),
    arn: a.string(),
  }),

  PermissionSet: a.customType({
    arn: a.string(),
    name: a.string(),
    description: a.string(),
  }),

  // Returned by evaluateMyAccess — one permitted (account, permissionSet) pair
  PermittedAccess: a.customType({
    accountId: a.string(),
    permissionSetArn: a.string(),
    permissionSetName: a.string(),
    maxDurationMinutes: a.integer(),
    requiresApproval: a.boolean(),
  }),

  // Represents a persisted access request record returned from the workflow stack.
  // The table itself lives in CDK (AccessRequestWorkflow stack) to avoid a
  // circular dependency between the data and workflow nested stacks.
  AccessRequestItem: a.customType({
    id: a.string(),
    idcUserId: a.string(),
    idcUserEmail: a.string(),
    idcUserDisplayName: a.string(),
    accountId: a.string(),
    permissionSetArn: a.string(),
    permissionSetName: a.string(),
    durationMinutes: a.integer(),
    status: a.string(),
    stepFunctionExecutionArn: a.string(),
    requiresApproval: a.boolean(),
    justification: a.string(),
    startTime: a.string(),
    activatedAt: a.string(),
    deactivatedAt: a.string(),
    approvedBy: a.string(),
    approverComment: a.string(),
    revokeComment: a.string(),
    createdAt: a.string(),
    updatedAt: a.string(),
  }),

  // Resolves the caller's own IDC user by matching the JWT email claim.
  // Available to all authenticated users (not just Admins).
  getMyIDCUser: a
    .query()
    .returns(a.ref("IDCUser"))
    .handler(a.handler.function(getMyIDCUserFunction))
    .authorization((allow) => [allow.authenticated()]),

  // Evaluates every (account, permissionSet) combination in the policy table
  // against AVP for the given IDC user ID and returns only the permitted pairs.
  evaluateMyAccess: a
    .query()
    .arguments({ idcUserId: a.string().required() })
    .returns(a.ref("PermittedAccess").array())
    .handler(a.handler.function(evaluateAccessFunction))
    .authorization((allow) => [allow.authenticated()]),

  // Returns all access requests for the given IDC user, newest first.
  listMyAccessRequests: a
    .query()
    .arguments({ idcUserId: a.string().required() })
    .returns(a.ref("AccessRequestItem").array())
    .handler(a.handler.function(listAccessRequestsFunction))
    .authorization((allow) => [allow.authenticated()]),

  listIDCUsers: a
    .query()
    .returns(a.ref("IDCUser").array())
    .handler(a.handler.function(listIDCUsersFunction))
    .authorization((allow) => [allow.group("Admins")]),

  listIDCGroups: a
    .query()
    .returns(a.ref("IDCGroup").array())
    .handler(a.handler.function(listIDCGroupsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  listAWSAccounts: a
    .query()
    .returns(a.ref("AWSAccount").array())
    .handler(a.handler.function(listAWSAccountsFunction))
    .authorization((allow) => [allow.authenticated()]),

  listOUs: a
    .query()
    .returns(a.ref("OrganizationalUnit").array())
    .handler(a.handler.function(listOUsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  listPermissionSets: a
    .query()
    .returns(a.ref("PermissionSet").array())
    .handler(a.handler.function(listPermissionSetsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  CognitoUser: a.customType({
    username: a.string(),
    email: a.string(),
    displayName: a.string(),
  }),

  CognitoGroup: a.customType({
    groupName: a.string(),
    description: a.string(),
  }),

  listCognitoUsers: a
    .query()
    .returns(a.ref("CognitoUser").array())
    .handler(a.handler.function(listCognitoUsersFunction))
    .authorization((allow) => [allow.group("Admins")]),

  listCognitoGroups: a
    .query()
    .returns(a.ref("CognitoGroup").array())
    .handler(a.handler.function(listCognitoGroupsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  // AVP-backed mutations — named with suffix to avoid clashing with the
  // auto-generated model mutations (createPrivilegedPolicy etc.)
  createPrivilegedPolicyWithAVP: a
    .mutation()
    .arguments({
      name: a.string().required(),
      description: a.string(),
      principalType: a.ref("PrincipalType"),
      principalId: a.string().required(),
      principalDisplayName: a.string(),
      accountIds: a.string().array(),
      ouIds: a.string().array(),
      permissionSetArns: a.string().array(),
      permissionSetNames: a.string().array(),
      maxDurationMinutes: a.integer(),
      requiresApproval: a.boolean(),
    })
    .returns(a.ref("PrivilegedPolicy"))
    .handler(a.handler.function(createPrivilegedPolicyFunction))
    .authorization((allow) => [allow.group("Admins")]),

  updatePrivilegedPolicyWithAVP: a
    .mutation()
    .arguments({
      id: a.string().required(),
      name: a.string().required(),
      description: a.string(),
      principalType: a.ref("PrincipalType"),
      principalId: a.string().required(),
      principalDisplayName: a.string(),
      accountIds: a.string().array(),
      ouIds: a.string().array(),
      permissionSetArns: a.string().array(),
      permissionSetNames: a.string().array(),
      maxDurationMinutes: a.integer(),
      requiresApproval: a.boolean(),
    })
    .returns(a.ref("PrivilegedPolicy"))
    .handler(a.handler.function(updatePrivilegedPolicyFunction))
    .authorization((allow) => [allow.group("Admins")]),

  deletePrivilegedPolicyWithAVP: a
    .mutation()
    .arguments({ id: a.string().required() })
    .returns(a.boolean())
    .handler(a.handler.function(deletePrivilegedPolicyFunction))
    .authorization((allow) => [allow.group("Admins")]),

  createApprovalPolicyWithAVP: a
    .mutation()
    .arguments({
      accountId: a.string().required(),
      accountName: a.string(),
      principalType: a.ref("PrincipalType"),
      principalId: a.string().required(),
      principalDisplayName: a.string(),
      permissionSetArns: a.string().array(),
      permissionSetNames: a.string().array(),
    })
    .returns(a.ref("ApprovalPolicy"))
    .handler(a.handler.function(createApprovalPolicyFunction))
    .authorization((allow) => [allow.group("Admins")]),

  deleteApprovalPolicyWithAVP: a
    .mutation()
    .arguments({
      accountId: a.string().required(),
      principalKey: a.string().required(),
    })
    .returns(a.boolean())
    .handler(a.handler.function(deleteApprovalPolicyFunction))
    .authorization((allow) => [allow.group("Admins")]),

  // Starts the privileged-access workflow: persists the request in the
  // workflow-stack DynamoDB table and triggers the Step Function.
  requestAccess: a
    .mutation()
    .arguments({
      idcUserId: a.string().required(),
      idcUserEmail: a.string(),
      idcUserDisplayName: a.string(),
      accountId: a.string().required(),
      permissionSetArn: a.string().required(),
      permissionSetName: a.string().required(),
      durationMinutes: a.integer().required(),
      requiresApproval: a.boolean(),
      justification: a.string().required(),
      startTime: a.string(),
    })
    .returns(a.ref("AccessRequestItem"))
    .handler(a.handler.function(requestAccessFunction))
    .authorization((allow) => [allow.authenticated()]),

  // Returns PENDING_APPROVAL requests the calling user is authorized to approve
  // (via AVP IsAuthorized on Snitch::PermissionSet). Available to any authenticated
  // user so non-admin approvers can access the page.
  listPendingApprovals: a
    .query()
    .returns(a.ref("AccessRequestItem").array())
    .handler(a.handler.function(listPendingApprovalsFunction))
    .authorization((allow) => [allow.authenticated()]),

  approveRequest: a
    .mutation()
    .arguments({
      requestId: a.string().required(),
      approverComment: a.string(),
    })
    .returns(a.ref("AccessRequestItem"))
    .handler(a.handler.function(approveRequestFunction))
    .authorization((allow) => [allow.authenticated()]),

  rejectRequest: a
    .mutation()
    .arguments({
      requestId: a.string().required(),
      approverComment: a.string(),
    })
    .returns(a.ref("AccessRequestItem"))
    .handler(a.handler.function(rejectRequestFunction))
    .authorization((allow) => [allow.authenticated()]),

  // Returns every access request across all users, newest first. Admin-only.
  listAllAccessRequests: a
    .query()
    .returns(a.ref("AccessRequestItem").array())
    .handler(a.handler.function(listAllAccessRequestsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  // Signals the WaitForEarlyRevocation state to proceed to RemovePermissionSet.
  // Admin-only. The request must have status ACTIVE.
  revokeAccess: a
    .mutation()
    .arguments({ requestId: a.string().required(), revokeComment: a.string() })
    .returns(a.ref("AccessRequestItem"))
    .handler(a.handler.function(revokeAccessFunction))
    .authorization((allow) => [allow.group("Admins")]),

  // ─── App Settings ─────────────────────────────────────────────────────────

  AppSettings: a.customType({
    cloudTrailLogGroupName: a.string(),
  }),

  getAppSettings: a
    .query()
    .returns(a.ref("AppSettings"))
    .handler(a.handler.function(getSettingsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  updateAppSettings: a
    .mutation()
    .arguments({ cloudTrailLogGroupName: a.string().required() })
    .returns(a.ref("AppSettings"))
    .handler(a.handler.function(updateSettingsFunction))
    .authorization((allow) => [allow.group("Admins")]),

  // ─── CloudTrail audit logs ─────────────────────────────────────────────────

  CloudTrailLogEvent: a.customType({
    eventId: a.string(),
    timestamp: a.string(),
    eventTime: a.string(),
    eventName: a.string(),
    eventSource: a.string(),
    userIdentityType: a.string(),
    userIdentityArn: a.string(),
    sourceIPAddress: a.string(),
    awsRegion: a.string(),
    errorCode: a.string(),
    errorMessage: a.string(),
    readOnly: a.boolean(),
  }),

  // Fetches CloudTrail events from the configured CloudWatch log group filtered
  // by the requester's email (matches userIdentity.arn in AssumedRole sessions).
  getCloudTrailLogs: a
    .query()
    .arguments({
      startTime: a.string().required(),
      endTime: a.string().required(),
      idcUserEmail: a.string().required(),
    })
    .returns(a.ref("CloudTrailLogEvent").array())
    .handler(a.handler.function(getCloudTrailLogsFunction))
    .authorization((allow) => [allow.group("Admins")]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
