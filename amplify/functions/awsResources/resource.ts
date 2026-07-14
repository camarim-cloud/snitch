import { defineFunction } from "@aws-amplify/backend";

const TIMEOUT = 30;

export const getMyIDCUserFunction = defineFunction({
  name: "getMyIDCUser",
  entry: "./getMyIDCUserHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listIDCUsersFunction = defineFunction({
  name: "listIDCUsers",
  entry: "./listIDCUsersHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listIDCGroupsFunction = defineFunction({
  name: "listIDCGroups",
  entry: "./listIDCGroupsHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listAWSAccountsFunction = defineFunction({
  name: "listAWSAccounts",
  entry: "./listAWSAccountsHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listOUsFunction = defineFunction({
  name: "listOUs",
  entry: "./listOUsHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listPermissionSetsFunction = defineFunction({
  name: "listPermissionSets",
  entry: "./listPermissionSetsHandler.ts",
  timeoutSeconds: TIMEOUT,
});

export const listCognitoUsersFunction = defineFunction({
  name: "listCognitoUsers",
  entry: "./listCognitoUsersHandler.ts",
  timeoutSeconds: TIMEOUT,
});
