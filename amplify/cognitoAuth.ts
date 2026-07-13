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
import { SecretValue, Stack } from "aws-cdk-lib";

function requireSynthEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Environment variable ${name} is required for synth-time Cognito config.`);
  }
  return value;
}

const outputDomainPrefix = requireSynthEnv("COGNITO_DOMAIN_PREFIX");
const outputCallbackUrl = requireSynthEnv("APP_CALLBACK_URL");
const outputIdentityStoreId = requireSynthEnv("IDC_IDENTITY_STORE_ID");
const outputAdminGroupName = requireSynthEnv("ADMIN_GROUP_NAME");
// Fallback default (unlike ADMIN_GROUP_NAME) so pre-existing deploys that don't yet
// set this synth var keep deploying; operators override it to their IDC auditor group.
const outputAuditorGroupName = requireSynthEnv("AUDITOR_GROUP_NAME", "AWSTeamAuditors");

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

  const metadataUrl = SecretValue.secretsManager("snitch/auth-config", {
    jsonField: "IDC_SAML_METADATA_URL",
  }).unsafeUnwrap();

  const samlProvider = new CfnUserPoolIdentityProvider(authStack, "IDCSAMLProvider", {
    userPoolId: userPool.userPoolId,
    providerName: "IDC",
    providerType: "SAML",
    providerDetails: { MetadataURL: metadataUrl, IDPSignout: "false" },
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
        "identitystore:DescribeGroup",
      ],
      resources: ["*"],
    })
  );
  preTokenLambda.addEnvironment("IDC_IDENTITY_STORE_ID", outputIdentityStoreId);
  preTokenLambda.addEnvironment("ADMIN_GROUP_NAME", outputAdminGroupName);
  preTokenLambda.addEnvironment("AUDITOR_GROUP_NAME", outputAuditorGroupName);

  // Amplify Gen 2 registers preTokenGeneration as V1 by default; V2_0 is required
  // so the Lambda response can use claimsAndScopeOverrideDetails. AWS rejects
  // templates that specify both PreTokenGeneration and PreTokenGenerationConfig.
  cfnUserPool.addPropertyOverride("LambdaConfig.PreTokenGenerationConfig", {
    LambdaArn: preTokenLambda.functionArn,
    LambdaVersion: "V2_0",
  });
  cfnUserPool.addPropertyDeletionOverride("LambdaConfig.PreTokenGeneration");
}
