import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { formatDuration } from "@/utils/duration";
import { formatDateTime } from "@/utils/formatDateTime";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";
import { type AccessRequestRow, toRows } from "@/utils/accessRequestRow";
import { RequestDetailsModal } from "@/components/RequestDetailsModal";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import Pagination from "@cloudscape-design/components/pagination";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import TextContent from "@cloudscape-design/components/text-content";
import TextFilter from "@cloudscape-design/components/text-filter";
import Textarea from "@cloudscape-design/components/textarea";
import FormField from "@cloudscape-design/components/form-field";

const client = generateClient<Schema>();

const PAGE_SIZE = 10;

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
      setAllRequests(toRows(res.data));
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

  useEffect(() => {
    const subs = [
      client.subscriptions.onAccessRequestCreated().subscribe({ next: () => void loadRequests() }),
      client.subscriptions.onAccessRequestApproved().subscribe({ next: () => void loadRequests() }),
      client.subscriptions.onAccessRequestRejected().subscribe({ next: () => void loadRequests() }),
      client.subscriptions.onAccessRequestRevoked().subscribe({ next: () => void loadRequests() }),
    ];
    return () => subs.forEach((s) => s.unsubscribe());
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
              cell: (r) => r.idcUserEmail || r.userLabel,
              sortingField: "idcUserEmail",
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
              cell: (r) => formatDateTime(r.createdAt),
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
                  <strong>User:</strong> {selected.idcUserEmail || selected.userLabel}
                  <br />
                  <strong>Account:</strong> {selected.accountId}
                  <br />
                  <strong>Permission Set:</strong> {selected.permissionSetName}
                  <br />
                  <strong>Duration:</strong> {formatDuration(selected.durationMinutes)}
                  <br />
                  <strong>Requested at:</strong> {formatDateTime(selected.createdAt)}
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
