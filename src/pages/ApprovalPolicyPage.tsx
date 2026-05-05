import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";

import Alert from "@cloudscape-design/components/alert";
import Autosuggest from "@cloudscape-design/components/autosuggest";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
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

type ApprovalPolicy = Schema["ApprovalPolicy"]["type"];
type Option = SelectProps.Option;

type AccountRow = {
  accountId: string;
  accountName: string;
  approvers: ApprovalPolicy[];
};

const PRINCIPAL_TYPE_OPTIONS: Option[] = [
  { label: "User", value: "USER" },
  { label: "Group", value: "GROUP" },
];

const PAGE_SIZE = 10;

function groupByAccount(policies: ApprovalPolicy[]): AccountRow[] {
  const map = new Map<string, AccountRow>();
  for (const p of policies) {
    if (!p.accountId) continue;
    const existing = map.get(p.accountId);
    if (existing) {
      existing.approvers.push(p);
    } else {
      map.set(p.accountId, {
        accountId: p.accountId,
        accountName: p.accountName ?? p.accountId,
        approvers: [p],
      });
    }
  }
  return [...map.values()];
}

export function ApprovalPolicyPage() {
  const [approvalPolicies, setApprovalPolicies] = useState<ApprovalPolicy[]>([]);
  const [loading, setLoading] = useState(true);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [modalAccountId, setModalAccountId] = useState("");
  const [modalAccountName, setModalAccountName] = useState("");
  const [modalPermissionSets, setModalPermissionSets] = useState<readonly Option[]>([]);
  const [modalPrincipalType, setModalPrincipalType] = useState<Option>(PRINCIPAL_TYPE_OPTIONS[0]);
  const [modalPrincipals, setModalPrincipals] = useState<readonly Option[]>([]);
  const [accountSuggestions, setAccountSuggestions] = useState<Option[]>([]);
  const [permissionSetOptions, setPermissionSetOptions] = useState<Option[]>([]);
  const [principalOptions, setPrincipalOptions] = useState<Option[]>([]);
  const [loadingPrincipalOptions, setLoadingPrincipalOptions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const accounts = groupByAccount(approvalPolicies);

  const {
    items: accountItems,
    filterProps,
    paginationProps,
    collectionProps,
    filteredItemsCount,
  } = useCollection(accounts, {
    filtering: {
      filteringFunction: (item, text) =>
        item.accountId.includes(text) ||
        item.accountName.toLowerCase().includes(text.toLowerCase()),
      empty: (
        <Box textAlign="center" color="inherit">
          <b>No approval policies configured</b>
          <Box padding={{ bottom: "s" }} variant="p" color="inherit">
            Add an approver to get started.
          </Box>
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          No accounts match the current filter.
        </Box>
      ),
    },
    pagination: { pageSize: PAGE_SIZE },
    selection: { trackBy: "accountId" },
  });

  // Derive selectedAccount from the current accounts array (not from the stale
  // collectionProps.selectedItems references) so the side panel always reflects
  // the latest approvalPolicies state after an add or delete.
  const selectedAccountId = (collectionProps.selectedItems as AccountRow[])[0]?.accountId ?? null;
  const selectedAccount = selectedAccountId
    ? (accounts.find((a) => a.accountId === selectedAccountId) ?? null)
    : null;

  const fetchApprovalPolicies = useCallback(async () => {
    setLoading(true);
    const res = await client.models.ApprovalPolicy.list({});
    setApprovalPolicies(res.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchApprovalPolicies();
  }, [fetchApprovalPolicies]);

  const loadModalResources = useCallback(async () => {
    const [accountsRes, permSetsRes] = await Promise.all([
      client.queries.listAWSAccounts(),
      client.queries.listPermissionSets(),
    ]);
    setAccountSuggestions(
      (accountsRes.data ?? []).map((a) => ({
        value: a?.id ?? "",
        label: a?.name ?? a?.id ?? "",
        description: a?.id ?? undefined,
      }))
    );
    setPermissionSetOptions(
      (permSetsRes.data ?? []).map((ps) => ({
        value: ps?.arn ?? "",
        label: ps?.name ?? ps?.arn ?? "",
        description: ps?.arn ?? undefined,
      }))
    );
  }, []);

  const loadPrincipalOptions = useCallback(async (principalType: string) => {
    setLoadingPrincipalOptions(true);
    setPrincipalOptions([]);
    try {
      if (principalType === "USER") {
        const res = await client.queries.listCognitoUsers();
        setPrincipalOptions(
          (res.data ?? []).map((u) => ({
            label: u?.displayName ?? u?.email ?? u?.username ?? "",
            value: u?.username ?? "",
            description: u?.email ?? undefined,
          }))
        );
      } else {
        const res = await client.queries.listCognitoGroups();
        setPrincipalOptions(
          (res.data ?? []).map((g) => ({
            label: g?.groupName ?? "",
            value: g?.groupName ?? "",
            description: g?.description ?? undefined,
          }))
        );
      }
    } finally {
      setLoadingPrincipalOptions(false);
    }
  }, []);

  function openAddModal(prefillAccountId?: string, prefillAccountName?: string) {
    setModalAccountId(prefillAccountId ?? "");
    setModalAccountName(prefillAccountName ?? "");
    setModalPermissionSets([]);
    setModalPrincipalType(PRINCIPAL_TYPE_OPTIONS[0]);
    setModalPrincipals([]);
    setSubmitError(null);
    setAddModalOpen(true);
    loadModalResources();
    loadPrincipalOptions("USER");
  }

  async function handlePrincipalTypeChange(option: Option) {
    setModalPrincipalType(option);
    setModalPrincipals([]);
    await loadPrincipalOptions(option.value ?? "USER");
  }

  function resolveAccountName(id: string): string {
    const match = accountSuggestions.find((s) => s.value === id);
    return match?.label ?? id;
  }

  async function handleAddApprovers() {
    if (!modalAccountId.trim()) {
      setSubmitError("Enter an account ID.");
      return;
    }
    if (modalPermissionSets.length === 0) {
      setSubmitError("Select at least one permission set.");
      return;
    }
    if (modalPrincipals.length === 0) {
      setSubmitError("Select at least one user or group.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const accountName = modalAccountName || resolveAccountName(modalAccountId);
    const permissionSetArns = modalPermissionSets.map((ps) => ps.value ?? "");
    const permissionSetNames = modalPermissionSets.map((ps) => ps.label ?? ps.value ?? "");
    try {
      await Promise.all(
        modalPrincipals.map((p) =>
          client.mutations.createApprovalPolicyWithAVP({
            accountId: modalAccountId.trim(),
            accountName: accountName || undefined,
            principalType: (modalPrincipalType.value ?? "USER") as "USER" | "GROUP",
            principalId: p.value ?? "",
            principalDisplayName: p.label ?? "",
            permissionSetArns,
            permissionSetNames,
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

  async function handleDeleteApprover(accountId: string, principalKey: string) {
    const compositeKey = `${accountId}#${principalKey}`;
    setDeletingId(compositeKey);
    try {
      await client.mutations.deleteApprovalPolicyWithAVP({ accountId, principalKey });
      setApprovalPolicies((prev) =>
        prev.filter((a) => !(a.accountId === accountId && a.principalKey === principalKey))
      );
    } finally {
      setDeletingId(null);
    }
  }

  const counterText =
    filteredItemsCount !== undefined
      ? `(${filteredItemsCount} / ${accounts.length})`
      : `(${accounts.length})`;

  return (
    <>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Configure who can approve access requests per AWS account"
          >
            Approval Policies
          </Header>
        }
      >
        <SpaceBetween size="l">
          <Table
            {...collectionProps}
            selectionType="single"
            loading={loading}
            loadingText="Loading approval policies..."
            columnDefinitions={[
              {
                id: "accountName",
                header: "Account",
                cell: (item) => item.accountName,
                sortingField: "accountName",
              },
              {
                id: "accountId",
                header: "Account ID",
                cell: (item) => item.accountId,
                sortingField: "accountId",
              },
              {
                id: "approverCount",
                header: "Approvers",
                cell: (item) => item.approvers.length,
              },
            ]}
            items={accountItems}
            filter={
              <TextFilter
                {...filterProps}
                filteringPlaceholder="Find by account name or ID"
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
                variant="h2"
                counter={counterText}
                actions={
                  <Button iconName="add-plus" onClick={() => openAddModal()}>
                    Add approver
                  </Button>
                }
              >
                Accounts with approval policies
              </Header>
            }
          />

          {selectedAccount && (
            <AccountApproversPanel
              account={selectedAccount}
              deletingId={deletingId}
              onAddApprover={() => openAddModal(selectedAccount.accountId, selectedAccount.accountName)}
              onDeleteApprover={handleDeleteApprover}
            />
          )}
        </SpaceBetween>
      </ContentLayout>

      <Modal
        visible={addModalOpen}
        onDismiss={() => setAddModalOpen(false)}
        header="Add approver"
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
          <FormField
            label="Account"
            description="The AWS account ID the approver can approve requests for."
          >
            <Autosuggest
              value={modalAccountId}
              onChange={({ detail }) => {
                setModalAccountId(detail.value);
                const match = accountSuggestions.find((s) => s.value === detail.value);
                if (match) setModalAccountName(match.label ?? "");
              }}
              options={accountSuggestions}
              enteredTextLabel={(v) => `Use "${v}"`}
              placeholder="Account ID or name"
            />
          </FormField>
          <FormField
            label="Permission sets"
            description="The approver can only approve requests that use one of these permission sets on this account."
          >
            <Multiselect
              selectedOptions={modalPermissionSets}
              onChange={({ detail }) => setModalPermissionSets(detail.selectedOptions)}
              options={permissionSetOptions}
              filteringType="auto"
              placeholder="Select permission sets"
              empty="No permission sets found"
            />
          </FormField>
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
                ? "Cognito groups whose members can approve requests for this account."
                : "Cognito users who can approve requests for this account."
            }
          >
            {loadingPrincipalOptions ? (
              <Spinner />
            ) : (
              <Multiselect
                selectedOptions={modalPrincipals}
                onChange={({ detail }) => setModalPrincipals(detail.selectedOptions)}
                options={principalOptions}
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

type AccountApproversPanelProps = {
  account: AccountRow;
  deletingId: string | null;
  onAddApprover: () => void;
  onDeleteApprover: (accountId: string, principalKey: string) => void;
};

function AccountApproversPanel({
  account,
  deletingId,
  onAddApprover,
  onDeleteApprover,
}: AccountApproversPanelProps) {
  const { items, filterProps, paginationProps, collectionProps, filteredItemsCount } =
    useCollection(account.approvers, {
      filtering: {
        filteringFunction: (item, text) =>
          (item.principalDisplayName ?? item.principalId ?? "")
            .toLowerCase()
            .includes(text.toLowerCase()),
        empty: (
          <Box textAlign="center" color="inherit">
            No approvers configured for this account.
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
    <Container
      header={
        <Header variant="h2">
          Approvers — {account.accountName}
          {account.accountName !== account.accountId && (
            <Box variant="span" color="text-body-secondary" fontSize="body-s">
              {" "}({account.accountId})
            </Box>
          )}
        </Header>
      }
    >
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
            id: "permissionSets",
            header: "Permission sets",
            cell: (item) =>
              (item.permissionSetNames ?? []).filter(Boolean).join(", ") ||
              (item.permissionSetArns ?? []).filter(Boolean).join(", ") ||
              "-",
          },
          {
            id: "actions",
            header: "",
            cell: (item) => (
              <Button
                variant="inline-link"
                loading={deletingId === `${item.accountId}#${item.principalKey}`}
                onClick={() => onDeleteApprover(item.accountId, item.principalKey)}
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
            actions={
              <Button onClick={onAddApprover} iconName="add-plus">
                Add approver
              </Button>
            }
          >
            Approvers
          </Header>
        }
      />
    </Container>
  );
}
