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

type DeleteInput = { id: string };
type AppSyncEvent = { arguments: DeleteInput };

/**
 * AppSync mutation resolver that deletes an ApprovalPolicy record.
 * Deletes DynamoDB first, then AVP (compensating-transaction order:
 * DDB first → AVP, matching the update/delete pattern in other handlers).
 */
export const handler = async (event: AppSyncEvent) => {
  const { id } = event.arguments;

  const getResult = await dynamo.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id } })
  );

  if (!getResult.Item) {
    throw new Error(`ApprovalPolicy not found: ${id}`);
  }

  const { avpPolicyId } = getResult.Item;

  await dynamo.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { id } }));

  if (avpPolicyId) {
    await avp.send(
      new DeletePolicyCommand({ policyStoreId: POLICY_STORE_ID, policyId: avpPolicyId })
    );
  }

  return true;
};
