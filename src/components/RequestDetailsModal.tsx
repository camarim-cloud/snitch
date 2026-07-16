import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { formatDuration } from "@/utils/duration";
import { formatDateTime } from "@/utils/formatDateTime";
import { accessRequestStatusType } from "@/utils/accessRequestStatus";
import type { AccessRequestRow } from "@/utils/accessRequestRow";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import Pagination from "@cloudscape-design/components/pagination";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import TextFilter from "@cloudscape-design/components/text-filter";

const client = generateClient<Schema>();

const LOGS_PAGE_SIZE = 20;

type CloudTrailLogRow = NonNullable<
  NonNullable<
    Awaited<ReturnType<typeof client.queries.getCloudTrailLogs>>["data"]
  >[number]
>;

type RequestDetailsModalProps = {
  request: AccessRequestRow;
  visible: boolean;
  onDismiss: () => void;
  // When false, only the request metadata is shown and no CloudTrail query runs.
  // Approval History passes false — a never-activated request has no session window.
  showCloudTrail?: boolean;
};

/**
 * Read-only details view for a single access request. Shows request metadata and,
 * when showCloudTrail is true (default), the CloudTrail events for the session window.
 *
 * @example
 *   <RequestDetailsModal request={row} visible={open} onDismiss={close} />          // session logs
 *   <RequestDetailsModal request={row} visible={open} onDismiss={close} showCloudTrail={false} />  // metadata only
 */
export function RequestDetailsModal({
  request,
  visible,
  onDismiss,
  showCloudTrail = true,
}: RequestDetailsModalProps) {
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
      const endIso =
        request.deactivatedAt ||
        new Date(
          new Date(startIso).getTime() + request.durationMinutes * 60 * 1000
        ).toISOString();

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
    if (visible && showCloudTrail) fetchLogs();
    else {
      setLogs([]);
      setLogsError("");
    }
  }, [visible, showCloudTrail, fetchLogs]);

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
      header={`Request Details — ${request.idcUserEmail || request.userLabel}`}
    >
      <SpaceBetween size="l">
        {/* Request metadata */}
        <ColumnLayout columns={3} variant="text-grid">
          <SpaceBetween size="xs">
            <Box fontWeight="bold" variant="awsui-key-label">User</Box>
            <Box>{request.idcUserEmail || request.userLabel}</Box>
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
            <Box>{formatDateTime(request.createdAt)}</Box>
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
          {request.approverComment && (
            <SpaceBetween size="xs">
              <Box fontWeight="bold" variant="awsui-key-label">Approver comment</Box>
              <Box>{request.approverComment}</Box>
            </SpaceBetween>
          )}
          {request.decidedAt && (
            <SpaceBetween size="xs">
              <Box fontWeight="bold" variant="awsui-key-label">Decided at</Box>
              <Box>{formatDateTime(request.decidedAt)}</Box>
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
        {showCloudTrail && (
          <>
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
                    cell: (r) => formatDateTime(r.eventTime ?? r.timestamp ?? ""),
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
          </>
        )}
      </SpaceBetween>
    </Modal>
  );
}
