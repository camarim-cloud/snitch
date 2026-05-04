import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  DeletePolicyCommand,
} from "@aws-sdk/client-verifiedpermissions";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;
const TABLE_NAME = process.env.APPROVAL_POLICY_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type DeleteInput = { permissionSetArn: string; principalKey: string };
type AppSyncEvent = { arguments: DeleteInput };

/**
 * AppSync mutation resolver that deletes an ApprovalPolicy record.
 * The composite key (permissionSetArn + principalKey) drives the GetItem and DeleteItem
 * calls directly — no scan or secondary index needed.
 * Deletes DynamoDB first, then AVP (compensating-transaction order).
 */
export const handler = async (event: AppSyncEvent) => {
  const { permissionSetArn, principalKey } = event.arguments;
  const key = { permissionSetArn, principalKey };

  const getResult = await dynamo.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if (!getResult.Item) {
    throw new Error(`ApprovalPolicy not found: ${permissionSetArn} / ${principalKey}`);
  }

  const { avpPolicyId } = getResult.Item;

  await dynamo.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }));

  if (avpPolicyId) {
    await avp.send(
      new DeletePolicyCommand({ policyStoreId: POLICY_STORE_ID, policyId: avpPolicyId })
    );
  }

  return true;
};
