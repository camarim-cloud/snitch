import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction, IFunction } from "aws-cdk-lib/aws-lambda";
import { IUserPool } from "aws-cdk-lib/aws-cognito";

interface AWSResourceFunctionParams {
  userPool: IUserPool;
  idcFunctions: IFunction[];
  cognitoFunctions: IFunction[];
}

export function setupAWSResourceFunctions({
  userPool,
  idcFunctions,
  cognitoFunctions,
}: AWSResourceFunctionParams): void {
  const awsResourcePolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "sso:ListInstances",
      "sso:ListPermissionSets",
      "sso:DescribePermissionSet",
      "identitystore:ListUsers",
      "identitystore:ListGroups",
      "organizations:ListAccounts",
      "organizations:ListRoots",
      "organizations:ListOrganizationalUnitsForParent",
    ],
    resources: ["*"],
  });

  for (const fn of idcFunctions) {
    fn.addToRolePolicy(awsResourcePolicy);
  }

  const cognitoListPolicy = new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["cognito-idp:ListUsers"],
    resources: [userPool.userPoolArn],
  });

  for (const fn of cognitoFunctions) {
    fn.addToRolePolicy(cognitoListPolicy);
    (fn as LambdaFunction).addEnvironment("AUTH_USER_POOL_ID", userPool.userPoolId);
  }
}
