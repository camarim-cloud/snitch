import { defineFunction } from "@aws-amplify/backend";

export const preTokenGenerationFunction = defineFunction({
  name: "pre-token-generation",
  entry: "./preTokenGenerationHandler.ts",
  resourceGroupName: "auth",
});
