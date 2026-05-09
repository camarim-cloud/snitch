import { defineFunction } from "@aws-amplify/backend";

export const getSettingsFunction = defineFunction({
  name: "getSettings",
  entry: "./getSettingsHandler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
});

export const updateSettingsFunction = defineFunction({
  name: "updateSettings",
  entry: "./updateSettingsHandler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
});
