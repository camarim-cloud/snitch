import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { formatDuration } from "@/utils/duration";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import Pagination from "@cloudscape-design/components/pagination";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import TextContent from "@cloudscape-design/components/text-content";
import TextFilter from "@cloudscape-design/components/text-filter";
import Textarea from "@cloudscape-design/components/textarea";
import FormField from "@cloudscape-design/components/form-field";

const client = generateClient<Schema>();

const PAGE_SIZE = 10;
const LOGS_PAGE_SIZE = 20;

const ALL_STATUSES = [
  "PENDING",
  "PENDING_APPROVAL",
  "SCHEDULED",
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
  "REJECTED",
  "FAILED",
] as const;

const STATUS_FILTER_OPTIONS: SelectProps.Option[] = [
  { label: "All statuses", value: "" },
  ...ALL_STATUSES.map((s) => ({ label: s, value: s })),
];


type AccessRequestRow = {
  id: string;
  idcUserId: string;
  idcUserEmail: string;
  userLabel: string;
  accountId: string;
  permissionSetArn: string;
  permissionSetName: string;
  status: string;
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
};

type RawItem = NonNullable<
  Awaited<ReturnType<typeof client.queries.listAllAccessRequests>>["data"]
>[number];

function toRow(item: NonNullable<RawItem>): AccessRequestRow {
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
  };
}

// ─── CloudTrail log types ─────────────────────────────────────────────────────

type CloudTrailLogRow = NonNullable<
  NonNullable<
    Awaited<ReturnType<typeof client.queries.getCloudTrailLogs>>["data"]
  >[number]
>;

// ─── Details modal ────────────────────────────────────────────────────────────

type RequestDetailsModalProps = {
  request: AccessRequestRow;
  visible: boolean;
  onDismiss: () => void;
};

function RequestDetailsModal({ request, visible, onDismiss }: RequestDetailsModalProps) {
  const [logs, setLogs] = useState<CloudTrailLogRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");

  const fetchLogs = useCallback(async () => {
    if (!request.idcUserEmail) {
      setLogs([]);
      return;
    }
    setLogsLoading(true);
    setLogsError("");
    try {
      const startIso = request.activatedAt || request.createdAt;
      const endIso = request.deactivatedAt ||
        new Date(new Date(startIso).getTime() + request.durationMinutes * 60 * 1000).toISOString();

      const res = await client.queries.getCloudTrailLogs({
        startTime: startIso,
        endTime: endIso,
        idcUserEmail: request.idcUserEmail,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setLogs(
        (res.data ?? []).filter((e): e is CloudTrailLogRow => e !== null)
      );
    } catch (err) {
      setLogsError(
        err instanceof Error ? err.message : "Failed to load CloudTrail logs"
      );
    } finally {
      setLogsLoading(false);
    }
  }, [request]);

  useEffect(() => {
    if (visible) fetchLogs();
    else {
      setLogs([]);
      setLogsError("");
    }
  }, [visible, fetchLogs]);

  const {
    items: logItems,
    filterProps: logFilterProps,
    paginationProps: logPaginationProps,
    collectionProps: logCollectionProps,
    filteredItemsCount: logFilteredCount,
  } = useCollection(logs, {
    filtering: {
      filteringFunction: (item, text) => {
        const q = text.toLowerCase();
        return (
          (item.eventName ?? "").toLowerCase().includes(q) ||
          (item.eventSource ?? "").toLowerCase().includes(q) ||
          (item.userIdentityArn ?? "").toLowerCase().includes(q) ||
          (item.sourceIPAddress ?? "").toLowerCase().includes(q)
        );
      },
      empty: (
        <Box textAlign="center" color="inherit">
          {logsLoading ? <Spinner /> : "No CloudTrail events found for this request window"}
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          No matches for the current filter
        </Box>
      ),
    },
    pagination: { pageSize: LOGS_PAGE_SIZE },
  });

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="max"
      header={`Request Details — ${request.userLabel}`}
    >
      <SpaceBetween size="l">
        {/* Request metadata */}
        <ColumnLayout columns={3} variant="text-grid">
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">User</Box>
            <Box>{request.userLabel}</Box>
          </SpaceBetween>
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">Account ID</Box>
            <Box>{request.accountId}</Box>
          </SpaceBetween>
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">Permission Set</Box>
            <Box>{request.permissionSetName}</Box>
          </SpaceBetween>
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">Status</Box>
            <StatusIndicator type={accessRequestStatusType(request.status)}>
              {request.status}
            </StatusIndicator>
          </SpaceBetween>
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">Duration</Box>
            <Box>{formatDuration(request.durationMinutes)}</Box>
          </SpaceBetween>
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">Requested at</Box>
            <Box>{request.createdAt}</Box>
          </SpaceBetween>
          {request.justification && (
            <SpaceBetween size="xs">
              <Box fontWeight="bold" variant="awsui-key-label">Justification</Box>
              <Box>{request.justification}</Box>
            </SpaceBetween>
          )}
          {request.approvedBy && (
            <SpaceBetween size="xs">
              <Box fontWeight="bold" variant="awsui-key-label">Approved by</Box>
              <Box>{request.approvedBy}</Box>
            </SpaceBetween>
          )}
          {request.revokeComment && (
            <SpaceBetween size="xs">
              <Box fontWeight="bold" variant="awsui-key-label">Revoke reason</Box>
              <Box>{request.revokeComment}</Box>
            </SpaceBetween>
          )}
        </ColumnLayout>

        {/* CloudTrail logs */}
        {logsError && <Alert type="error">{logsError}</Alert>}

        {!request.idcUserEmail ? (
          <Alert type="warning">
            No email address on record for this requester — cannot load CloudTrail logs.
          </Alert>
        ) : (
          <Table
            {...logCollectionProps}
            loading={logsLoading}
            loadingText="Loading CloudTrail events"
            items={logItems}
            columnDefinitions={[
              {
                id: "eventTime",
                header: "Event Time",
                cell: (r) => r.eventTime ?? r.timestamp ?? "",
                width: 200,
              },
              {
                id: "eventName",
                header: "Event Name",
                cell: (r) => r.eventName ?? "",
              },
              {
                id: "eventSource",
                header: "Event Source",
                cell: (r) => r.eventSource ?? "",
              },
              {
                id: "userIdentityArn",
                header: "User Identity",
                cell: (r) => r.userIdentityArn ?? "",
              },
              {
                id: "sourceIPAddress",
                header: "Source IP",
                cell: (r) => r.sourceIPAddress ?? "",
                width: 140,
              },
              {
                id: "awsRegion",
                header: "Region",
                cell: (r) => r.awsRegion ?? "",
                width: 120,
              },
              {
                id: "error",
                header: "Error",
                cell: (r) =>
                  r.errorCode ? (
                    <StatusIndicator type="error">{r.errorCode}</StatusIndicator>
                  ) : (
                    "—"
                  ),
                width: 160,
              },
            ]}
            filter={
              <TextFilter
                {...logFilterProps}
                filteringPlaceholder="Find by event, source or identity"
                countText={
                  logFilteredCount !== undefined
                    ? `${logFilteredCount} match${logFilteredCount !== 1 ? "es" : ""}`
                    : undefined
                }
              />
            }
            header={
              <Header
                variant="h3"
                counter={logsLoading ? undefined : `(${logs.length})`}
                actions={
                  <Button iconName="refresh" onClick={fetchLogs} loading={logsLoading}>
                    Refresh
                  </Button>
                }
              >
                CloudTrail Events
              </Header>
            }
            pagination={<Pagination {...logPaginationProps} />}
          />
        )}
      </SpaceBetween>
    </Modal>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ElevatedAccessPage() {
  const [allRequests, setAllRequests] = useState<AccessRequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [statusFilter, setStatusFilter] = useState<SelectProps.Option>(
    STATUS_FILTER_OPTIONS[0]
  );
  const [revokeModalOpen, setRevokeModalOpen] = useState(false);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const [revokeComment, setRevokeComment] = useState("");

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.listAllAccessRequests();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setAllRequests(
        (res.data ?? [])
          .filter((r): r is NonNullable<RawItem> => r !== null)
          .map(toRow)
      );
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load access requests"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // Status dropdown is applied before the collection hook so text filter
  // and pagination always operate on the already-status-filtered set.
  const filteredByStatus = statusFilter.value
    ? allRequests.filter((r) => r.status === statusFilter.value)
    : allRequests;

  const { items, filterProps, paginationProps, collectionProps, actions, filteredItemsCount } =
    useCollection(filteredByStatus, {
      filtering: {
        filteringFunction: (item, text) => {
          const q = text.toLowerCase();
          return (
            item.userLabel.toLowerCase().includes(q) ||
            item.accountId.toLowerCase().includes(q) ||
            item.permissionSetName.toLowerCase().includes(q)
          );
        },
        empty: (
          <Box textAlign="center" color="inherit">
            No access requests found
          </Box>
        ),
        noMatch: (
          <Box textAlign="center" color="inherit">
            No matches for the current filter
          </Box>
        ),
      },
      pagination: { pageSize: PAGE_SIZE },
      selection: { trackBy: "id" },
    });

  const selected = (collectionProps.selectedItems as AccessRequestRow[])?.[0];
  const canRevoke = selected?.status === "ACTIVE";

  function handleStatusFilterChange(option: SelectProps.Option) {
    setStatusFilter(option);
    actions.setSelectedItems([]);
  }

  async function handleRevoke() {
    if (!selected) return;
    setRevoking(true);
    setRevokeError("");
    try {
      const res = await client.mutations.revokeAccess({
        requestId: selected.id,
        revokeComment: revokeComment.trim() || undefined,
      });
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setRevokeModalOpen(false);
      setRevokeComment("");
      actions.setSelectedItems([]);
      setAllRequests((prev) =>
        prev.map((r) =>
          r.id === selected.id
            ? { ...r, status: "REVOKED", revokeComment: revokeComment.trim() }
            : r
        )
      );
    } catch (err) {
      setRevokeError(
        err instanceof Error ? err.message : "Revoke failed. Please try again."
      );
    } finally {
      setRevoking(false);
    }
  }

  const counterText = filterProps.filteringText
    ? `(${filteredItemsCount} / ${filteredByStatus.length})`
    : `(${filteredByStatus.length})`;

  return (
    <ContentLayout header={<Header variant="h1">Elevated Access</Header>}>
      <SpaceBetween size="m">
        {loadError && <Alert type="error">{loadError}</Alert>}

        <Table
          {...collectionProps}
          loading={loading}
          loadingText="Loading access requests"
          items={items}
          selectionType="single"
          columnDefinitions={[
            {
              id: "user",
              header: "User",
              cell: (r) => r.userLabel,
              sortingField: "userLabel",
            },
            {
              id: "accountId",
              header: "Account ID",
              cell: (r) => r.accountId,
            },
            {
              id: "permissionSet",
              header: "Permission Set",
              cell: (r) => r.permissionSetName,
            },
            {
              id: "status",
              header: "Status",
              cell: (r) => (
                <StatusIndicator type={accessRequestStatusType(r.status)}>
                  {r.status}
                </StatusIndicator>
              ),
              width: 180,
            },
            {
              id: "duration",
              header: "Duration",
              cell: (r) => formatDuration(r.durationMinutes),
              width: 140,
            },
            {
              id: "createdAt",
              header: "Requested at",
              cell: (r) => r.createdAt,
            },
            {
              id: "revokeComment",
              header: "Revoke reason",
              cell: (r) => r.revokeComment || "—",
            },
          ]}
          filter={
            <SpaceBetween direction="horizontal" size="xs">
              <TextFilter
                {...filterProps}
                filteringPlaceholder="Find by user, account or permission set"
                countText={
                  filteredItemsCount !== undefined
                    ? `${filteredItemsCount} match${filteredItemsCount !== 1 ? "es" : ""}`
                    : undefined
                }
              />
              <Select
                selectedOption={statusFilter}
                onChange={({ detail }) =>
                  handleStatusFilterChange(detail.selectedOption)
                }
                options={STATUS_FILTER_OPTIONS}
              />
            </SpaceBetween>
          }
          header={
            <Header
              variant="h2"
              counter={counterText}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="refresh"
                    loading={loading}
                    onClick={loadRequests}
                  >
                    Refresh
                  </Button>
                  <Button
                    disabled={!selected}
                    onClick={() => setDetailsModalOpen(true)}
                  >
                    View Details
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!canRevoke}
                    onClick={() => {
                      setRevokeError("");
                      setRevokeComment("");
                      setRevokeModalOpen(true);
                    }}
                  >
                    Revoke Access
                  </Button>
                </SpaceBetween>
              }
            >
              All Access Requests
            </Header>
          }
          pagination={<Pagination {...paginationProps} />}
        />

        {selected && (
          <RequestDetailsModal
            request={selected}
            visible={detailsModalOpen}
            onDismiss={() => setDetailsModalOpen(false)}
          />
        )}

        <Modal
          visible={revokeModalOpen}
          onDismiss={() => setRevokeModalOpen(false)}
          header="Revoke access"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="link"
                  onClick={() => setRevokeModalOpen(false)}
                  disabled={revoking}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={revoking}
                  onClick={handleRevoke}
                >
                  Confirm revocation
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {revokeError && <Alert type="error">{revokeError}</Alert>}
            {selected && (
              <TextContent>
                <p>
                  This will immediately signal the Step Function to proceed to
                  permission removal for:
                </p>
                <p>
                  <strong>User:</strong> {selected.userLabel}
                  <br />
                  <strong>Account:</strong> {selected.accountId}
                  <br />
                  <strong>Permission Set:</strong> {selected.permissionSetName}
                  <br />
                  <strong>Duration:</strong> {formatDuration(selected.durationMinutes)}
                  <br />
                  <strong>Requested at:</strong> {selected.createdAt}
                </p>
                <p>This action cannot be undone.</p>
              </TextContent>
            )}
            <FormField
              label="Justification"
              description="Reason for revoking access early. Stored with the request for audit purposes."
            >
              <Textarea
                value={revokeComment}
                onChange={({ detail }) => setRevokeComment(detail.value)}
                placeholder="Enter the reason for revoking access..."
                rows={3}
              />
            </FormField>
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
    </ContentLayout>
  );
}
