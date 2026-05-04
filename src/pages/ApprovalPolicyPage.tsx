import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import Pagination from "@cloudscape-design/components/pagination";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import TextFilter from "@cloudscape-design/components/text-filter";

const client = generateClient<Schema>();

type Policy = Schema["PrivilegedPolicy"]["type"];
type ApprovalPolicy = Schema["ApprovalPolicy"]["type"];
type Option = SelectProps.Option;

const PRINCIPAL_TYPE_OPTIONS: Option[] = [
  { label: "User", value: "USER" },
  { label: "Group", value: "GROUP" },
];

const PAGE_SIZE = 10;

export function ApprovalPolicyPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [approvalPolicies, setApprovalPolicies] = useState<ApprovalPolicy[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(true);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [modalPermissionSetArn, setModalPermissionSetArn] = useState("");
  const [modalPermissionSetName, setModalPermissionSetName] = useState("");
  const [modalPrincipalType, setModalPrincipalType] = useState<Option>(PRINCIPAL_TYPE_OPTIONS[0]);
  const [modalPrincipals, setModalPrincipals] = useState<readonly Option[]>([]);
  const [modalOptions, setModalOptions] = useState<Option[]>([]);
  const [loadingModalOptions, setLoadingModalOptions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const requiresApprovalPolicies = policies.filter((p) => p.requiresApproval);

  const {
    items: policyItems,
    filterProps,
    paginationProps,
    collectionProps,
    filteredItemsCount,
  } = useCollection(requiresApprovalPolicies, {
    filtering: {
      filteringFunction: (item, text) =>
        item.name.toLowerCase().includes(text.toLowerCase()),
      empty: (
        <Box textAlign="center" color="inherit">
          <b>No policies require approval</b>
          <Box padding={{ bottom: "s" }} variant="p" color="inherit">
            Enable "Require approval" on a Privileged Policy to configure approvers here.
          </Box>
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          No policies match the current filter
        </Box>
      ),
    },
    pagination: { pageSize: PAGE_SIZE },
    selection: { trackBy: "id" },
  });

  const selectedPolicies = collectionProps.selectedItems as Policy[];
  const selectedPolicy = selectedPolicies[0] ?? null;

  const fetchData = useCallback(async () => {
    setLoadingPolicies(true);
    const [policiesRes, approvalRes] = await Promise.all([
      client.models.PrivilegedPolicy.list({}),
      client.models.ApprovalPolicy.list({}),
    ]);
    setPolicies(policiesRes.data);
    setApprovalPolicies(approvalRes.data);
    setLoadingPolicies(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const loadPrincipalOptions = useCallback(async (principalType: string) => {
    setLoadingModalOptions(true);
    setModalOptions([]);
    try {
      if (principalType === "USER") {
        const res = await client.queries.listCognitoUsers();
        setModalOptions(
          (res.data ?? []).map((u) => ({
            label: u?.displayName ?? u?.email ?? u?.username ?? "",
            value: u?.username ?? "",
            description: u?.email ?? undefined,
          }))
        );
      } else {
        const res = await client.queries.listCognitoGroups();
        setModalOptions(
          (res.data ?? []).map((g) => ({
            label: g?.groupName ?? "",
            value: g?.groupName ?? "",
            description: g?.description ?? undefined,
          }))
        );
      }
    } finally {
      setLoadingModalOptions(false);
    }
  }, []);

  function openAddModal(permissionSetArn: string, permissionSetName: string) {
    setModalPermissionSetArn(permissionSetArn);
    setModalPermissionSetName(permissionSetName);
    setModalPrincipalType(PRINCIPAL_TYPE_OPTIONS[0]);
    setModalPrincipals([]);
    setSubmitError(null);
    setAddModalOpen(true);
    loadPrincipalOptions("USER");
  }

  async function handlePrincipalTypeChange(option: Option) {
    setModalPrincipalType(option);
    setModalPrincipals([]);
    await loadPrincipalOptions(option.value ?? "USER");
  }

  async function handleAddApprovers() {
    if (modalPrincipals.length === 0) {
      setSubmitError("Select at least one user or group.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await Promise.all(
        modalPrincipals.map((p) =>
          client.mutations.createApprovalPolicyWithAVP({
            permissionSetArn: modalPermissionSetArn,
            permissionSetName: modalPermissionSetName || undefined,
            principalType: (modalPrincipalType.value ?? "USER") as "USER" | "GROUP",
            principalId: p.value ?? "",
            principalDisplayName: p.label ?? "",
          })
        )
      );
      setAddModalOpen(false);
      const res = await client.models.ApprovalPolicy.list({});
      setApprovalPolicies(res.data);
    } catch {
      setSubmitError("Failed to add approver. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteApprover(id: string) {
    setDeletingId(id);
    try {
      await client.mutations.deleteApprovalPolicyWithAVP({ id });
      setApprovalPolicies((prev) => prev.filter((a) => a.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  const counterText = filteredItemsCount !== undefined
    ? `(${filteredItemsCount} / ${requiresApprovalPolicies.length})`
    : `(${requiresApprovalPolicies.length})`;

  return (
    <>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Configure who can approve access requests for each permission set"
          >
            Approval Policies
          </Header>
        }
      >
        <SpaceBetween size="l">
          <Table
            {...collectionProps}
            selectionType="single"
            loading={loadingPolicies}
            loadingText="Loading policies..."
            columnDefinitions={[
              {
                id: "name",
                header: "Policy name",
                cell: (item) => item.name,
                sortingField: "name",
              },
              {
                id: "principal",
                header: "Principal",
                cell: (item) =>
                  `${item.principalType === "GROUP" ? "Group" : "User"}: ${item.principalDisplayName ?? item.principalId}`,
              },
              {
                id: "permissionSets",
                header: "Permission sets",
                cell: (item) =>
                  item.permissionSetNames?.filter(Boolean).join(", ") || "-",
              },
            ]}
            items={policyItems}
            filter={
              <TextFilter
                {...filterProps}
                filteringPlaceholder="Find by policy name"
                countText={
                  filteredItemsCount !== undefined
                    ? `${filteredItemsCount} match${filteredItemsCount !== 1 ? "es" : ""}`
                    : undefined
                }
              />
            }
            pagination={<Pagination {...paginationProps} />}
            header={
              <Header variant="h2" counter={counterText}>
                Policies requiring approval
              </Header>
            }
          />

          {selectedPolicy && (
            <ApprovalConfigPanel
              policy={selectedPolicy}
              approvalPolicies={approvalPolicies}
              deletingId={deletingId}
              onAddApprover={openAddModal}
              onDeleteApprover={handleDeleteApprover}
            />
          )}
        </SpaceBetween>
      </ContentLayout>

      <Modal
        visible={addModalOpen}
        onDismiss={() => setAddModalOpen(false)}
        header={`Add approvers — ${modalPermissionSetName || modalPermissionSetArn}`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setAddModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={submitting} onClick={handleAddApprovers}>
                Add
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {submitError && <Alert type="error">{submitError}</Alert>}
          <FormField label="Principal type">
            <Select
              selectedOption={modalPrincipalType}
              onChange={({ detail }) => handlePrincipalTypeChange(detail.selectedOption)}
              options={PRINCIPAL_TYPE_OPTIONS}
            />
          </FormField>
          <FormField
            label={modalPrincipalType.value === "GROUP" ? "Groups" : "Users"}
            description={
              modalPrincipalType.value === "GROUP"
                ? "Cognito groups whose members can approve requests for this permission set."
                : "Cognito users who can approve requests for this permission set."
            }
          >
            {loadingModalOptions ? (
              <Spinner />
            ) : (
              <Multiselect
                selectedOptions={modalPrincipals}
                onChange={({ detail }) => setModalPrincipals(detail.selectedOptions)}
                options={modalOptions}
                filteringType="auto"
                placeholder={`Select ${modalPrincipalType.value === "GROUP" ? "groups" : "users"}`}
                empty="No results found"
              />
            )}
          </FormField>
        </SpaceBetween>
      </Modal>
    </>
  );
}

type ApprovalConfigPanelProps = {
  policy: Policy;
  approvalPolicies: ApprovalPolicy[];
  deletingId: string | null;
  onAddApprover: (permissionSetArn: string, permissionSetName: string) => void;
  onDeleteApprover: (id: string) => void;
};

function ApprovalConfigPanel({
  policy,
  approvalPolicies,
  deletingId,
  onAddApprover,
  onDeleteApprover,
}: ApprovalConfigPanelProps) {
  const permissionSets: { arn: string; name: string }[] = (policy.permissionSetArns ?? []).map(
    (arn, i) => ({
      arn: arn ?? "",
      name: policy.permissionSetNames?.[i] ?? arn ?? "",
    })
  );

  return (
    <Container
      header={
        <Header variant="h2">
          Approval configurations — {policy.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {permissionSets.length === 0 ? (
          <Box color="text-body-secondary">This policy has no permission sets configured.</Box>
        ) : (
          <ColumnLayout columns={1} borders="horizontal">
            {permissionSets.map((ps) => (
              <PermissionSetApprovers
                key={ps.arn}
                permissionSetArn={ps.arn}
                permissionSetName={ps.name}
                approvalPolicies={approvalPolicies.filter((a) => a.permissionSetArn === ps.arn)}
                deletingId={deletingId}
                onAdd={() => onAddApprover(ps.arn, ps.name)}
                onDelete={onDeleteApprover}
              />
            ))}
          </ColumnLayout>
        )}
      </SpaceBetween>
    </Container>
  );
}

type PermissionSetApproversProps = {
  permissionSetArn: string;
  permissionSetName: string;
  approvalPolicies: ApprovalPolicy[];
  deletingId: string | null;
  onAdd: () => void;
  onDelete: (id: string) => void;
};

function PermissionSetApprovers({
  permissionSetName,
  permissionSetArn,
  approvalPolicies,
  deletingId,
  onAdd,
  onDelete,
}: PermissionSetApproversProps) {
  const { items, filterProps, paginationProps, collectionProps, filteredItemsCount } =
    useCollection(approvalPolicies, {
      filtering: {
        filteringFunction: (item, text) =>
          (item.principalDisplayName ?? item.principalId ?? "")
            .toLowerCase()
            .includes(text.toLowerCase()),
        empty: (
          <Box textAlign="center" color="inherit">
            No approvers configured for this permission set.
          </Box>
        ),
        noMatch: (
          <Box textAlign="center" color="inherit">
            No approvers match the filter.
          </Box>
        ),
      },
      pagination: { pageSize: 5 },
    });

  return (
    <SpaceBetween size="s">
      <Table
        {...collectionProps}
        columnDefinitions={[
          {
            id: "type",
            header: "Type",
            cell: (item) => (item.principalType === "GROUP" ? "Group" : "User"),
            width: 90,
          },
          {
            id: "name",
            header: "Name",
            cell: (item) => item.principalDisplayName ?? item.principalId ?? "-",
          },
          {
            id: "actions",
            header: "",
            cell: (item) => (
              <Button
                variant="inline-link"
                loading={deletingId === item.id}
                onClick={() => onDelete(item.id)}
              >
                Remove
              </Button>
            ),
            width: 100,
          },
        ]}
        items={items}
        filter={
          <TextFilter
            {...filterProps}
            filteringPlaceholder="Find approver"
            countText={
              filteredItemsCount !== undefined
                ? `${filteredItemsCount} match${filteredItemsCount !== 1 ? "es" : ""}`
                : undefined
            }
          />
        }
        pagination={<Pagination {...paginationProps} />}
        header={
          <Header
            variant="h3"
            description={permissionSetArn}
            actions={
              <Button onClick={onAdd} iconName="add-plus">
                Add approver
              </Button>
            }
          >
            {permissionSetName}
          </Header>
        }
      />
    </SpaceBetween>
  );
}
