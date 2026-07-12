import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Throws if any existing policy already covers the exact same (principalId, accountId/ouId, permissionSetArn)
 * combination. Conflicts are only enforced when all three match, allowing different permission sets
 * for the same principal-resource pair.
 *
 * Example (allowed): user "abc" → account "123" with "ReadOnly" exists.
 * Adding "abc" → "123" with "AdminAccess" is permitted—different permission set.
 *
 * Example (rejected): user "abc" → account "123" with "ReadOnly" exists.
 * Adding "abc" → "123" with "ReadOnly" is rejected—exact duplicate.
 */
export async function assertNoDuplicatePrincipalResource(
  dynamo: DynamoDBDocumentClient,
  tableName: string,
  {
    principalId,
    accountIds,
    ouIds,
    permissionSetArns,
    excludeId,
  }: {
    principalId: string;
    accountIds: string[];
    ouIds: string[];
    permissionSetArns: string[];
    excludeId?: string;
  }
): Promise<void> {
  if (accountIds.length === 0 && ouIds.length === 0) return;
  if (permissionSetArns.length === 0) return;

  const result = await dynamo.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "principalId = :pid",
      ExpressionAttributeValues: { ":pid": principalId },
    })
  );

  for (const item of result.Items ?? []) {
    if (excludeId && item.id === excludeId) continue;

    const existingAccounts: string[] = item.accountIds ?? [];
    const existingOus: string[] = item.ouIds ?? [];
    const existingPermissionSets: string[] = item.permissionSetArns ?? [];

    const conflictingAccounts = accountIds.filter((id) => existingAccounts.includes(id));
    const conflictingOus = ouIds.filter((id) => existingOus.includes(id));
    const conflictingPermissionSets = permissionSetArns.filter((arn) =>
      existingPermissionSets.includes(arn)
    );

    // Only throw if there's an overlap in BOTH resources AND permission sets
    if (
      (conflictingAccounts.length > 0 || conflictingOus.length > 0) &&
      conflictingPermissionSets.length > 0
    ) {
      const resources = [...conflictingAccounts, ...conflictingOus].join(", ");
      const permSets = conflictingPermissionSets.join(", ");
      throw new Error(
        `Policy "${item.name}" already grants this principal access to ${resources} ` +
          `with permission sets: ${permSets}. ` +
          `Edit the existing policy or use different permission sets.`
      );
    }
  }
}
