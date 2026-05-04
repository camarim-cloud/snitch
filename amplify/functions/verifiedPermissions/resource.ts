import { defineFunction } from "@aws-amplify/backend";

const TIMEOUT = 30;

// Assigned to the "data" stack to avoid a circular dependency:
// the data stack references these functions as AppSync resolvers, and these
// functions need DynamoDB table name + AVP policy store ID from the data stack.
export const createPrivilegedPolicyFunction = defineFunction({
  name: "createPrivilegedPolicy",
  entry: "./createPrivilegedPolicyHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});

export const updatePrivilegedPolicyFunction = defineFunction({
  name: "updatePrivilegedPolicy",
  entry: "./updatePrivilegedPolicyHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});

export const deletePrivilegedPolicyFunction = defineFunction({
  name: "deletePrivilegedPolicy",
  entry: "./deletePrivilegedPolicyHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});

export const evaluateAccessFunction = defineFunction({
  name: "evaluateAccess",
  entry: "./evaluateAccessHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});

export const createApprovalPolicyFunction = defineFunction({
  name: "createApprovalPolicy",
  entry: "./createApprovalPolicyHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});

export const deleteApprovalPolicyFunction = defineFunction({
  name: "deleteApprovalPolicy",
  entry: "./deleteApprovalPolicyHandler.ts",
  timeoutSeconds: TIMEOUT,
  resourceGroupName: "data",
});
