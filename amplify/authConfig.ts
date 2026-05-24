import { execSync } from "child_process";

const SECRET_ID = "snitch/auth-config";

// Reads COGNITO_DOMAIN_PREFIX and APP_CALLBACK_URL from Secrets Manager at CDK synth
// time so backend.addOutput can write resolved values to amplify_outputs.json.
// CloudFormation does not expand SM dynamic references in stack Outputs, so these
// two fields must be available as plain strings before synthesis completes.
function readSynthTimeAuthConfig(): {
  domainPrefix: string;
  callbackUrl: string;
  identityStoreId: string;
  adminGroupName: string;
} {
  try {
    const json = execSync(
      `aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --query SecretString --output text`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const secret = JSON.parse(json.trim()) as Record<string, string>;
    return {
      domainPrefix: secret["COGNITO_DOMAIN_PREFIX"] ?? "",
      callbackUrl: secret["APP_CALLBACK_URL"] ?? "http://localhost:5173",
      identityStoreId: secret["IDC_IDENTITY_STORE_ID"] ?? "",
      adminGroupName: secret["ADMIN_GROUP_NAME"] ?? "",
    };
  } catch {
    console.warn(`[authConfig] Could not read ${SECRET_ID} at synth time — outputs will be empty`);
    return { domainPrefix: "", callbackUrl: "http://localhost:5173", identityStoreId: "", adminGroupName: "" };
  }
}

export const {
  domainPrefix: outputDomainPrefix,
  callbackUrl: outputCallbackUrl,
  identityStoreId: outputIdentityStoreId,
  adminGroupName: outputAdminGroupName,
} = readSynthTimeAuthConfig();
