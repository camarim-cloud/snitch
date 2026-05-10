import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import { formatDuration } from "@/utils/duration";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import TextContent from "@cloudscape-design/components/text-content";
import Pagination from "@cloudscape-design/components/pagination";

const client = generateClient<Schema>();

type PendingRequest = NonNullable<
  Awaited<ReturnType<typeof client.queries.listPendingApprovals>>["data"]
>[number];

type RequestRow = {
  id: string;
  idcUserId: string;
  idcUserLabel: string;
  accountId: string;
  permissionSetName: string;
  permissionSetArn: string;
  durationMinutes: number;
  justification: string;
  startTime: string | null;
  createdAt: string;
};

function toRow(item: NonNullable<PendingRequest>): RequestRow {
  return {
    id: item.id ?? "",
    idcUserId: item.idcUserId ?? "",
    idcUserLabel:
      item.idcUserEmail ?? item.idcUserDisplayName ?? item.idcUserId ?? "",
    accountId: item.accountId ?? "",
    permissionSetName: item.permissionSetName ?? "",
    permissionSetArn: item.permissionSetArn ?? "",
    durationMinutes: item.durationMinutes ?? 0,
    justification: item.justification ?? "",
    startTime: item.startTime ?? null,
    createdAt: item.createdAt ?? "",
  };
}

export function ApproveRequestsPage() {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedItems, setSelectedItems] = useState<RequestRow[]>([]);

  const [modalMode, setModalMode] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await client.queries.listPendingApprovals();
      if (res.errors?.length) {
        throw new Error(res.errors.map((e) => e.message).join("; "));
      }
      setRequests(
        (res.data ?? [])
          .filter((r): r is NonNullable<PendingRequest> => r !== null)
          .map(toRow)
      );
      setCurrentPage(1);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load pending approvals"
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
    ];
    return () => subs.forEach((s) => s.unsubscribe());
  }, [loadRequests]);

  function openModal(mode: "approve" | "reject") {
    setComment("");
    setActionError("");
    setModalMode(mode);
  }

  async function handleAction() {
    const selected = selectedItems[0];
    if (!selected || !modalMode) return;
    setSubmitting(true);
    setActionError("");
    try {
      if (modalMode === "approve") {
        const res = await client.mutations.approveRequest({
          requestId: selected.id,
          approverComment: comment || undefined,
        });
        if (res.errors?.length) {
          throw new Error(res.errors.map((e) => e.message).join("; "));
        }
      } else {
        const res = await client.mutations.rejectRequest({
          requestId: selected.id,
          approverComment: comment || undefined,
        });
        if (res.errors?.length) {
          throw new Error(res.errors.map((e) => e.message).join("; "));
        }
      }
      setModalMode(null);
      setSelectedItems([]);
      // Optimistically remove the item so the table updates immediately,
      // even before the backend status propagates (approve is async via Step Functions).
      setRequests((prev) => prev.filter((r) => r.id !== selected.id));
      loadRequests();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Action failed. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  const selected = selectedItems[0];

  return (
    <>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Review and act on access requests awaiting your approval"
          >
            Approve Requests
          </Header>
        }
      >
        <SpaceBetween size="m">
          {loadError && (
            <Alert
              key="load-error"
              type="error"
              header="Failed to load pending requests"
              action={<Button onClick={loadRequests}>Retry</Button>}
            >
              {loadError}
            </Alert>
          )}

          <Table key="requests-table"
            selectionType="single"
            selectedItems={selectedItems}
            onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
            columnDefinitions={[
              {
                id: "idcUserId",
                header: "IDC User",
                cell: (item) => item.idcUserLabel,
              },
              {
                id: "accountId",
                header: "Account",
                cell: (item) => item.accountId,
              },
              {
                id: "permissionSetName",
                header: "Permission Set",
                cell: (item) => item.permissionSetName,
              },
              {
                id: "durationMinutes",
                header: "Duration",
                cell: (item) => formatDuration(item.durationMinutes),
                width: 130,
              },
              {
                id: "status",
                header: "Status",
                cell: () => (
                  <StatusIndicator type="pending">Pending approval</StatusIndicator>
                ),
                width: 160,
              },
              {
                id: "startTime",
                header: "Start time",
                cell: (item) => item.startTime ?? "—",
              },
              {
                id: "createdAt",
                header: "Requested at",
                cell: (item) => item.createdAt,
              },
            ]}
            items={requests.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)}
            loading={loading}
            loadingText="Loading pending requests…"
            pagination={
              <Pagination
                currentPageIndex={currentPage}
                pagesCount={Math.max(1, Math.ceil(requests.length / PAGE_SIZE))}
                onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)}
              />
            }
            empty={
              <Box textAlign="center" color="inherit">
                <b>No pending requests</b>
                <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                  There are no access requests awaiting your approval.
                </Box>
              </Box>
            }
            header={
              <Header
                variant="h2"
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      iconName="thumbs-down"
                      disabled={!selected}
                      loading={submitting}
                      onClick={() => openModal("reject")}
                    >
                      Reject
                    </Button>
                    <Button
                      iconName="thumbs-up"
                      disabled={!selected}
                      loading={submitting}
                      onClick={() => openModal("approve")}
                    >
                      Approve
                    </Button>
                  </SpaceBetween>
                }
              >
                Pending approvals
              </Header>
            }
          />

        </SpaceBetween>
      </ContentLayout>

      <Modal
        visible={modalMode !== null}
        onDismiss={() => setModalMode(null)}
        header={modalMode === "approve" ? "Approve request" : "Reject request"}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setModalMode(null)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={submitting}
                onClick={handleAction}
              >
                {modalMode === "approve" ? "Confirm approval" : "Confirm rejection"}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {actionError && <Alert key="action-error" type="error">{actionError}</Alert>}
          {selected && (
            <TextContent key="request-details">
              <p>
                <strong>IDC User:</strong> {selected.idcUserLabel}
                <br />
                <strong>Account:</strong> {selected.accountId}
                <br />
                <strong>Permission Set:</strong> {selected.permissionSetName}
                <br />
                <strong>Duration:</strong> {formatDuration(selected.durationMinutes)}
                <br />
                <strong>Requested at:</strong> {selected.createdAt}
                <br />
                <strong>Justification:</strong> {selected.justification || "—"}
              </p>
            </TextContent>
          )}
          <FormField
            key="comment-field"
            label="Comment — optional"
            description="This comment will be stored with the request record."
          >
            <Input
              value={comment}
              onChange={({ detail }) => setComment(detail.value)}
              placeholder="Add a comment…"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </>
  );
}
