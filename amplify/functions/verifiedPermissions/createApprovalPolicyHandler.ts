import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  VerifiedPermissionsClient,
  CreatePolicyCommand,
} from "@aws-sdk/client-verifiedpermissions";
import { randomUUID } from "crypto";
import { buildApprovalCedarPolicy } from "./buildApprovalCedarPolicy";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const POLICY_STORE_ID = process.env.AVP_POLICY_STORE_ID!;
const TABLE_NAME = process.env.APPROVAL_POLICY_TABLE_NAME!;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const avp = new VerifiedPermissionsClient({ region: REGION });

type CreateInput = {
  permissionSetArn: string;
  permissionSetName?: string | null;
  principalType?: "USER" | "GROUP" | null;
  principalId: string;
  principalDisplayName?: string | null;
};

type AppSyncEvent = { arguments: CreateInput };

/**
 * AppSync mutation resolver that creates an ApprovalPolicy record.
 * Writes a Cedar `approve` permit policy to AVP first, then persists
 * the record to DynamoDB. Rolls back the AVP policy if the DDB write fails.
 */
export const handler = async (event: AppSyncEvent) => {
  const {
    permissionSetArn,
    permissionSetName,
    principalType,
    principalId,
    principalDisplayName,
  } = event.arguments;

  const cedarPolicy = buildApprovalCedarPolicy({
    principalType: principalType ?? "USER",
    principalId,
    permissionSetArn,
  });

  const createPolicyResult = await avp.send(
    new CreatePolicyCommand({
      policyStoreId: POLICY_STORE_ID,
      definition: {
        static: {
          statement: cedarPolicy,
          description: `approve: ${principalType ?? "USER"}/${principalId} → ${permissionSetArn}`,
        },
      },
    })
  );

  const avpPolicyId = createPolicyResult.policyId!;

  const id = randomUUID();
  const now = new Date().toISOString();

  const item = {
    id,
    permissionSetArn,
    permissionSetName: permissionSetName ?? null,
    principalType: principalType ?? "USER",
    principalId,
    principalDisplayName: principalDisplayName ?? null,
    avpPolicyId,
    createdAt: now,
    updatedAt: now,
    __typename: "ApprovalPolicy",
  };

  try {
    await dynamo.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch (err) {
    // Compensating transaction: remove the AVP policy so the two stores stay in sync
    const { DeletePolicyCommand } = await import("@aws-sdk/client-verifiedpermissions");
    await avp.send(new DeletePolicyCommand({ policyStoreId: POLICY_STORE_ID, policyId: avpPolicyId }));
    throw err;
  }

  return item;
};
