import {
  CfnManagedLoginBranding,
  CfnUserPool,
  CfnUserPoolClient,
  CfnUserPoolDomain,
  CfnUserPoolIdentityProvider,
  IUserPool,
} from "aws-cdk-lib/aws-cognito";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Stack } from "aws-cdk-lib";
import { requireSynthEnv, resolveCognitoDomainPrefix, resolveAppCallbackUrl } from "./synthEnv";

const outputDomainPrefix = resolveCognitoDomainPrefix(process.env);
const outputCallbackUrl = resolveAppCallbackUrl(process.env);
const outputIdentityStoreId = requireSynthEnv(process.env, "IDC_IDENTITY_STORE_ID");
// Public IAM Identity Center SAML metadata URL. Plain synth-time env var (was AWS Secrets
// Manager snitch/auth-config#IDC_SAML_METADATA_URL) — mirrors ADMIN_GROUP_ID.
const idcSamlMetadataUrl = requireSynthEnv(process.env, "IDC_SAML_METADATA_URL");
// Immutable IDC GroupId (a UUID), not a display name — so renaming the IDC group never breaks the
// Admins claim. Required.
const outputAdminGroupId = requireSynthEnv(process.env, "ADMIN_GROUP_ID");
// Optional: no GroupId default is meaningful, so pass through empty rather than a placeholder. The
// token handler only appends the Auditors claim when this id is set and matches a membership, so
// unset = nobody gets Auditors (the backward-safe behavior the old display-name fallback provided).
const outputAuditorGroupId = process.env.AUDITOR_GROUP_ID ?? "";

interface CognitoAuthParams {
  userPool: IUserPool;
  cfnUserPool: CfnUserPool;
  cfnUserPoolClient: CfnUserPoolClient;
  preTokenLambda: LambdaFunction;
}

export function setupCognitoAuth({
  userPool,
  cfnUserPool,
  cfnUserPoolClient,
  preTokenLambda,
}: CognitoAuthParams): void {
  const authStack = Stack.of(userPool);

  const samlProvider = new CfnUserPoolIdentityProvider(authStack, "IDCSAMLProvider", {
    userPoolId: userPool.userPoolId,
    providerName: "IDC",
    providerType: "SAML",
    providerDetails: { MetadataURL: idcSamlMetadataUrl, IDPSignout: "false" },
    attributeMapping: { email: "email" },
  });

  cfnUserPoolClient.allowedOAuthFlows = ["code"];
  cfnUserPoolClient.allowedOAuthScopes = ["openid", "email", "profile"];
  cfnUserPoolClient.allowedOAuthFlowsUserPoolClient = true;
  cfnUserPoolClient.supportedIdentityProviders = ["IDC"];
  cfnUserPoolClient.callbackUrLs = [outputCallbackUrl, "http://localhost:5173"];
  cfnUserPoolClient.logoutUrLs = [outputCallbackUrl, "http://localhost:5173"];
  cfnUserPoolClient.addDependency(samlProvider);

  const cognitoDomain = new CfnUserPoolDomain(authStack, "CognitoDomain", {
    userPoolId: userPool.userPoolId,
    domain: outputDomainPrefix,
    managedLoginVersion: 2,
  });

  const managedLoginBranding = new CfnManagedLoginBranding(authStack, "ManagedLoginBranding", {
    userPoolId: userPool.userPoolId,
    clientId: cfnUserPoolClient.ref,
    useCognitoProvidedValues: true,
  });
  managedLoginBranding.addDependency(cognitoDomain);

  preTokenLambda.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "identitystore:ListUsers",
        "identitystore:ListGroupMembershipsForMember",
      ],
      resources: ["*"],
    })
  );
  preTokenLambda.addEnvironment("IDC_IDENTITY_STORE_ID", outputIdentityStoreId);
  preTokenLambda.addEnvironment("ADMIN_GROUP_ID", outputAdminGroupId);
  preTokenLambda.addEnvironment("AUDITOR_GROUP_ID", outputAuditorGroupId);

  // Amplify Gen 2 registers preTokenGeneration as V1 by default; V2_0 is required
  // so the Lambda response can use claimsAndScopeOverrideDetails. AWS rejects
  // templates that specify both PreTokenGeneration and PreTokenGenerationConfig.
  cfnUserPool.addPropertyOverride("LambdaConfig.PreTokenGenerationConfig", {
    LambdaArn: preTokenLambda.functionArn,
    LambdaVersion: "V2_0",
  });
  cfnUserPool.addPropertyDeletionOverride("LambdaConfig.PreTokenGeneration");
}
