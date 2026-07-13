import type { Schema } from "../../amplify/data/resource";

// Flattened, null-coalesced projection of an AccessRequestItem for table rendering.
// Shared by every page that lists access requests (Elevated Access, Approval
// History, Session Activity) so the columns and the details modal agree on shape.
export type AccessRequestRow = {
  id: string;
  idcUserId: string;
  idcUserEmail: string;
  userLabel: string;
  accountId: string;
  permissionSetArn: string;
  permissionSetName: string;
  status: string;
  requiresApproval: boolean;
  durationMinutes: number;
  createdAt: string;
  updatedAt: string;
  startTime: string;
  activatedAt: string;
  deactivatedAt: string;
  revokeComment: string;
  justification: string;
  approvedBy: string;
  approverComment: string;
  decidedAt: string;
};

type AccessRequestItem = Schema["AccessRequestItem"]["type"];

/**
 * Maps a raw AccessRequestItem (nullable fields) into a display row with every
 * field defaulted to a safe empty value.
 *
 * @example
 *   const rows = (res.data ?? []).filter(Boolean).map(toRow);
 */
export function toRow(item: AccessRequestItem): AccessRequestRow {
  return {
    id: item.id ?? "",
    idcUserId: item.idcUserId ?? "",
    idcUserEmail: item.idcUserEmail ?? "",
    userLabel:
      item.idcUserDisplayName ?? item.idcUserEmail ?? item.idcUserId ?? "",
    accountId: item.accountId ?? "",
    permissionSetArn: item.permissionSetArn ?? "",
    permissionSetName: item.permissionSetName ?? "",
    status: item.status ?? "",
    requiresApproval: item.requiresApproval ?? false,
    durationMinutes: item.durationMinutes ?? 0,
    createdAt: item.createdAt ?? "",
    updatedAt: item.updatedAt ?? "",
    startTime: item.startTime ?? "",
    activatedAt: item.activatedAt ?? "",
    deactivatedAt: item.deactivatedAt ?? "",
    revokeComment: item.revokeComment ?? "",
    justification: item.justification ?? "",
    approvedBy: item.approvedBy ?? "",
    approverComment: item.approverComment ?? "",
    decidedAt: item.decidedAt ?? "",
  };
}

/**
 * Filters out nulls from a listAllAccessRequests / listMyAccessRequests result and
 * maps the survivors to display rows. Centralizes the null-narrowing so pages don't
 * each re-declare a raw-item type predicate.
 *
 * @example
 *   const res = await client.queries.listAllAccessRequests();
 *   setRows(toRows(res.data));
 */
export function toRows(
  items: ReadonlyArray<AccessRequestItem | null | undefined> | null | undefined
): AccessRequestRow[] {
  return (items ?? [])
    .filter((i): i is AccessRequestItem => i != null)
    .map(toRow);
}
