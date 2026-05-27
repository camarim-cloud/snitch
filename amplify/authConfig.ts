import { execSync } from "child_process";

const SECRET_ID = "snitch/auth-config";
const DEFAULT_CALLBACK_URL = "http://localhost:5173";

type SynthTimeAuthConfig = {
  domainPrefix: string;
  callbackUrl: string;
  identityStoreId: string;
  adminGroupName: string;
};

function readSecretAuthConfig(): Record<string, string> {
  try {
    const json = execSync(
      `aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --query SecretString --output text`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(json.trim()) as Record<string, string>;
  } catch {
    console.warn(`[authConfig] Could not read ${SECRET_ID} at synth time — falling back to environment variables or defaults`);
    return {};
  }
}

function getSynthValue(envName: string, secret: Record<string, string>, secretField: string, fallback = ""): string {
  return process.env[envName] ?? secret[secretField] ?? fallback;
}

function readSynthTimeAuthConfig(): SynthTimeAuthConfig {
  const synthEnvKeys = [
    "COGNITO_DOMAIN_PREFIX",
    "APP_CALLBACK_URL",
    "IDC_IDENTITY_STORE_ID",
    "ADMIN_GROUP_NAME",
  ];
  const shouldReadSecret = synthEnvKeys.some((key) => !process.env[key]);
  const secret = shouldReadSecret ? readSecretAuthConfig() : {};

  return {
    domainPrefix: getSynthValue("COGNITO_DOMAIN_PREFIX", secret, "COGNITO_DOMAIN_PREFIX"),
    callbackUrl: getSynthValue("APP_CALLBACK_URL", secret, "APP_CALLBACK_URL", DEFAULT_CALLBACK_URL),
    identityStoreId: getSynthValue("IDC_IDENTITY_STORE_ID", secret, "IDC_IDENTITY_STORE_ID"),
    adminGroupName: getSynthValue("ADMIN_GROUP_NAME", secret, "ADMIN_GROUP_NAME"),
  };
}

export const {
  domainPrefix: outputDomainPrefix,
  callbackUrl: outputCallbackUrl,
  identityStoreId: outputIdentityStoreId,
  adminGroupName: outputAdminGroupName,
} = readSynthTimeAuthConfig();
