import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";
import { type AccessRequestRow, toRows } from "@/utils/accessRequestRow";
import { RequestDetailsModal } from "@/components/RequestDetailsModal";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import Pagination from "@cloudscape-design/components/pagination";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import TextFilter from "@cloudscape-design/components/text-filter";

const client = generateClient<Schema>();

const PAGE_SIZE = 10;

// Statuses an approval-required request can reach (PENDING through terminal).
const APPROVAL_STATUSES = [
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
  ...APPROVAL_STATUSES.map((s) => ({ label: s, value: s })),
];

export function ApprovalHistoryPage() {
  const [allRequests, setAllRequests] = useState<AccessRequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [statusFilter, setStatusFilter] = useState<SelectProps.Option>(
    STATUS_FILTER_OPTIONS[0]
  );
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.listAllAccessRequests();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      // Only requests that went through the approval gate belong in this view.
      setAllRequests(toRows(res.data).filter((r) => r.requiresApproval));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load approval history"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

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
            item.permissionSetName.toLowerCase().includes(q) ||
            item.approvedBy.toLowerCase().includes(q)
          );
        },
        empty: (
          <Box textAlign="center" color="inherit">
            No approval-required requests found
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

  function handleStatusFilterChange(option: SelectProps.Option) {
    setStatusFilter(option);
    actions.setSelectedItems([]);
  }

  const counterText = filterProps.filteringText
    ? `(${filteredItemsCount} / ${filteredByStatus.length})`
    : `(${filteredByStatus.length})`;

  return (
    <ContentLayout header={<Header variant="h1">Approval History</Header>}>
      <SpaceBetween size="m">
        {loadError && <Alert type="error">{loadError}</Alert>}

        <Table
          {...collectionProps}
          loading={loading}
          loadingText="Loading approval history"
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
              header: "Decision",
              cell: (r) => (
                <StatusIndicator type={accessRequestStatusType(r.status)}>
                  {r.status}
                </StatusIndicator>
              ),
              width: 180,
            },
            {
              id: "approvedBy",
              header: "Decided by",
              cell: (r) => r.approvedBy || "—",
            },
            {
              id: "approverComment",
              header: "Comment",
              cell: (r) => r.approverComment || "—",
            },
            {
              id: "decidedAt",
              header: "Decided at",
              cell: (r) => r.decidedAt || r.updatedAt || "—",
            },
            {
              id: "createdAt",
              header: "Requested at",
              cell: (r) => r.createdAt,
            },
          ]}
          filter={
            <SpaceBetween direction="horizontal" size="xs">
              <TextFilter
                {...filterProps}
                filteringPlaceholder="Find by user, account, permission set or approver"
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
                  <Button iconName="refresh" loading={loading} onClick={loadRequests}>
                    Refresh
                  </Button>
                  <Button disabled={!selected} onClick={() => setDetailsModalOpen(true)}>
                    View Details
                  </Button>
                </SpaceBetween>
              }
            >
              Approval Requests
            </Header>
          }
          pagination={<Pagination {...paginationProps} />}
        />

        {selected && (
          <RequestDetailsModal
            request={selected}
            visible={detailsModalOpen}
            onDismiss={() => setDetailsModalOpen(false)}
            showCloudTrail={false}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
