import { useState, useEffect, useCallback } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  todayDateStr,
  minutesToMaxDuration,
  maxDurationToMinutes,
  formatDuration,
} from "@/utils/duration";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import DatePicker from "@cloudscape-design/components/date-picker";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Multiselect from "@cloudscape-design/components/multiselect";
import Pagination from "@cloudscape-design/components/pagination";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import TextFilter from "@cloudscape-design/components/text-filter";
import TimeInput from "@cloudscape-design/components/time-input";
import Toggle from "@cloudscape-design/components/toggle";

const client = generateClient<Schema>();

type Policy = Schema["PrivilegedPolicy"]["type"];
type Option = SelectProps.Option;

const PRINCIPAL_TYPE_OPTIONS: Option[] = [
  { label: "User", value: "USER" },
  { label: "Group", value: "GROUP" },
];

const PAGE_SIZE = 10;

type FormValues = {
  name: string;
  description: string;
  principalType: Option;
  principal: Option | null;
  accounts: readonly Option[];
  ous: readonly Option[];
  permissionSets: readonly Option[];
  maxDurationDate: string;
  maxDurationTime: string;
  requiresApproval: boolean;
};

const EMPTY_FORM: FormValues = {
  name: "",
  description: "",
  principalType: PRINCIPAL_TYPE_OPTIONS[0],
  principal: null,
  accounts: [],
  ous: [],
  permissionSets: [],
  maxDurationDate: "",
  maxDurationTime: "23:59",
  requiresApproval: false,
};

type AWSResources = {
  users: Option[];
  groups: Option[];
  accounts: Option[];
  ous: Option[];
  permissionSets: Option[];
};

const EMPTY_RESOURCES: AWSResources = {
  users: [],
  groups: [],
  accounts: [],
  ous: [],
  permissionSets: [],
};

export function PrivilegedPoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(true);

  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [formValues, setFormValues] = useState<FormValues>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameError, setNameError] = useState("");
  const [principalError, setPrincipalError] = useState("");
  const [permissionSetError, setPermissionSetError] = useState("");
  const [maxDurationError, setMaxDurationError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [awsResources, setAwsResources] = useState<AWSResources>(EMPTY_RESOURCES);
  const [loadingResources, setLoadingResources] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);

  const { items, filterProps, paginationProps, collectionProps, actions, filteredItemsCount } =
    useCollection(policies, {
      filtering: {
        filteringFunction: (item, text) =>
          item.name.toLowerCase().includes(text.toLowerCase()),
        empty: (
          <Box textAlign="center" color="inherit">
            <b>No policies</b>
            <Box padding={{ bottom: "s" }} variant="p" color="inherit">
              Create your first privileged policy to get started.
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

  const selectedItems = collectionProps.selectedItems as Policy[];


  const fetchPolicies = useCallback(async () => {
    setLoadingPolicies(true);
    const { data } = await client.models.PrivilegedPolicy.list({});
    setPolicies(data);
    actions.setCurrentPage(1);
    setLoadingPolicies(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const loadAWSResources = useCallback(async () => {
    setLoadingResources(true);
    setResourcesError(null);
    try {
      const [usersRes, groupsRes, accountsRes, ousRes, psRes] = await Promise.all([
        client.queries.listIDCUsers(),
        client.queries.listIDCGroups(),
        client.queries.listAWSAccounts(),
        client.queries.listOUs(),
        client.queries.listPermissionSets(),
      ]);

      const graphqlErrors = [usersRes, groupsRes, accountsRes, ousRes, psRes].flatMap(
        (r) => r.errors ?? []
      );
      if (graphqlErrors.length > 0) {
        console.error("AWS resource query errors:", graphqlErrors);
        setResourcesError(
          "Failed to load AWS resources. The backend may not be deployed yet — run `npm run sandbox`. " +
            graphqlErrors.map((e) => e.message).join("; ")
        );
        return;
      }

      const hasNullData = [usersRes, groupsRes, accountsRes, ousRes, psRes].some(
        (r) => r.data === null
      );
      if (hasNullData) {
        setResourcesError(
          "AWS resources returned no data. Make sure the backend is deployed: run `npm run sandbox`."
        );
        return;
      }

      setAwsResources({
        users: (usersRes.data ?? []).map((u) => ({
          label: u?.displayName ?? u?.userName ?? "",
          value: u?.id ?? "",
          description: u?.email ?? undefined,
        })),
        groups: (groupsRes.data ?? []).map((g) => ({
          label: g?.displayName ?? "",
          value: g?.id ?? "",
          description: g?.description ?? undefined,
        })),
        accounts: (accountsRes.data ?? []).map((a) => ({
          label: `${a?.name} (${a?.id})`,
          value: a?.id ?? "",
          description: a?.email ?? undefined,
        })),
        ous: (ousRes.data ?? []).map((ou) => ({
          label: ou?.name ?? "",
          value: ou?.id ?? "",
          description: ou?.arn ?? undefined,
        })),
        permissionSets: (psRes.data ?? []).map((ps) => ({
          label: ps?.name ?? "",
          value: ps?.arn ?? "",
          description: ps?.description ?? undefined,
        })),
      });
    } catch (err) {
      console.error("AWS resource load error:", err);
      setResourcesError(
        "Failed to load AWS resources. Check Lambda permissions and CloudWatch logs."
      );
    } finally {
      setLoadingResources(false);
    }
  }, []);

  function clearFormErrors() {
    setFormError(null);
    setNameError("");
    setPrincipalError("");
    setPermissionSetError("");
    setMaxDurationError("");
  }

  function openCreateModal() {
    setFormValues({ ...EMPTY_FORM, maxDurationDate: todayDateStr() });
    clearFormErrors();
    setModalMode("create");
    loadAWSResources();
  }

  function openEditModal() {
    const policy = selectedItems[0];
    if (!policy) return;

    const principalType =
      PRINCIPAL_TYPE_OPTIONS.find((o) => o.value === policy.principalType) ??
      PRINCIPAL_TYPE_OPTIONS[0];

    setFormValues({
      name: policy.name,
      description: policy.description ?? "",
      principalType,
      principal: policy.principalId
        ? {
            label: policy.principalDisplayName ?? policy.principalId,
            value: policy.principalId,
          }
        : null,
      accounts: (policy.accountIds ?? []).map((id) => ({ label: id ?? "", value: id ?? "" })),
      ous: (policy.ouIds ?? []).map((id) => ({ label: id ?? "", value: id ?? "" })),
      permissionSets: (policy.permissionSetArns ?? []).map((arn, i) => ({
        label: policy.permissionSetNames?.[i] ?? arn ?? "",
        value: arn ?? "",
      })),
      ...(() => {
        const { date, time } = policy.maxDurationMinutes
          ? minutesToMaxDuration(policy.maxDurationMinutes)
          : { date: todayDateStr(), time: "23:59" };
        return { maxDurationDate: date, maxDurationTime: time };
      })(),
      requiresApproval: policy.requiresApproval ?? false,
    });

    clearFormErrors();
    setModalMode("edit");
    loadAWSResources();
  }

  function validate(): boolean {
    setFormError(null);
    let valid = true;
    if (!formValues.name.trim()) {
      setNameError("Name is required.");
      valid = false;
    } else {
      setNameError("");
    }
    if (!formValues.principal) {
      setPrincipalError("A user or group is required.");
      valid = false;
    } else {
      setPrincipalError("");
    }
    if (formValues.permissionSets.length === 0) {
      setPermissionSetError("At least one permission set is required.");
      valid = false;
    } else {
      setPermissionSetError("");
    }
    if (formValues.maxDurationTime && !/^\d{2}:\d{2}$/.test(formValues.maxDurationTime)) {
      setMaxDurationError("Enter a valid time (hh:mm, 24-hour format).");
      valid = false;
    } else if (formValues.maxDurationTime) {
      const [h, m] = formValues.maxDurationTime.split(":").map(Number);
      if (h > 23 || m > 59) {
        setMaxDurationError("Enter a valid time (hh:mm, 24-hour format).");
        valid = false;
      } else if (formValues.maxDurationDate) {
        const [year, month, day] = formValues.maxDurationDate.split("-").map(Number);
        const selected = new Date(year, month - 1, day);
        const base = new Date();
        base.setHours(0, 0, 0, 0);
        const days = Math.round((selected.getTime() - base.getTime()) / 86400000);
        if (days > 365) {
          setMaxDurationError("Maximum duration is 1 year from today.");
          valid = false;
        } else {
          setMaxDurationError("");
        }
      } else {
        setMaxDurationError("");
      }
    } else {
      setMaxDurationError("");
    }

    if (valid) {
      const principalId = formValues.principal?.value ?? "";
      const newAccountIds = formValues.accounts.map((o) => o.value ?? "").filter(Boolean);
      const newOuIds = formValues.ous.map((o) => o.value ?? "").filter(Boolean);
      const currentId = modalMode === "edit" ? selectedItems[0]?.id : undefined;

      const conflict = policies.find((p) => {
        if (p.principalId !== principalId) return false;
        if (currentId && p.id === currentId) return false;
        const accountOverlap = newAccountIds.some((id) => (p.accountIds ?? []).includes(id));
        const ouOverlap = newOuIds.some((id) => (p.ouIds ?? []).includes(id));
        return accountOverlap || ouOverlap;
      });

      if (conflict) {
        setFormError(
          `"${conflict.name}" already grants this principal access to one or more of the selected accounts/OUs. ` +
            `Edit that policy to add the new permission set instead.`
        );
        valid = false;
      }
    }

    return valid;
  }

  async function handleSubmit() {
    if (!validate()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        name: formValues.name.trim(),
        description: formValues.description.trim() || undefined,
        principalType: formValues.principalType.value as "USER" | "GROUP",
        principalId: formValues.principal!.value ?? "",
        principalDisplayName: formValues.principal!.label ?? "",
        accountIds: formValues.accounts.map((o) => o.value ?? ""),
        ouIds: formValues.ous.map((o) => o.value ?? ""),
        permissionSetArns: formValues.permissionSets.map((o) => o.value ?? ""),
        permissionSetNames: formValues.permissionSets.map((o) => o.label ?? ""),
        maxDurationMinutes: maxDurationToMinutes(
          formValues.maxDurationDate,
          formValues.maxDurationTime
        ),
        requiresApproval: formValues.requiresApproval,
      };

      if (modalMode === "create") {
        await client.mutations.createPrivilegedPolicyWithAVP(payload);
      } else {
        await client.mutations.updatePrivilegedPolicyWithAVP({
          id: selectedItems[0].id,
          ...payload,
        });
      }

      setModalMode(null);
      actions.setSelectedItems([]);
      await fetchPolicies();
    } catch {
      setFormError("Failed to save policy. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const policy = selectedItems[0];
    if (!policy) return;
    setDeleting(true);
    try {
      await client.mutations.deletePrivilegedPolicyWithAVP({ id: policy.id });
      actions.setSelectedItems([]);
      await fetchPolicies();
    } finally {
      setDeleting(false);
    }
  }

  const principalOptions =
    formValues.principalType.value === "GROUP"
      ? awsResources.groups
      : awsResources.users;

  const counterText = filterProps.filteringText
    ? `(${filteredItemsCount} / ${policies.length})`
    : `(${policies.length})`;

  return (
    <>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Define which IAM Identity Center users or groups can access AWS accounts with specific Permission Sets"
          >
            Privileged Policies
          </Header>
        }
      >
        <Table
          {...collectionProps}
          selectionType="single"
          loading={loadingPolicies}
          loadingText="Loading policies..."
          columnDefinitions={[
            {
              id: "name",
              header: "Name",
              cell: (item) => item.name,
              sortingField: "name",
            },
            {
              id: "principalType",
              header: "Type",
              cell: (item) => item.principalType ?? "-",
              width: 90,
            },
            {
              id: "principal",
              header: "User / Group",
              cell: (item) => item.principalDisplayName ?? item.principalId,
            },
            {
              id: "accounts",
              header: "Accounts",
              cell: (item) => {
                const n = item.accountIds?.length ?? 0;
                return n > 0 ? `${n} account${n > 1 ? "s" : ""}` : "-";
              },
              width: 110,
            },
            {
              id: "ous",
              header: "OUs",
              cell: (item) => {
                const n = item.ouIds?.length ?? 0;
                return n > 0 ? `${n} OU${n > 1 ? "s" : ""}` : "-";
              },
              width: 90,
            },
            {
              id: "permissionSets",
              header: "Permission Sets",
              cell: (item) =>
                item.permissionSetNames?.filter(Boolean).join(", ") || "-",
            },
            {
              id: "maxDuration",
              header: "Max Duration",
              cell: (item) =>
                item.maxDurationMinutes ? formatDuration(item.maxDurationMinutes) : "No limit",
              width: 120,
            },
            {
              id: "requiresApproval",
              header: "Approval",
              cell: (item) => (item.requiresApproval ? "Required" : "-"),
              width: 100,
            },
          ]}
          items={items}
          filter={
            <TextFilter
              {...filterProps}
              filteringPlaceholder="Find by name"
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
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    disabled={selectedItems.length === 0}
                    loading={deleting}
                    onClick={handleDelete}
                  >
                    Delete
                  </Button>
                  <Button
                    disabled={selectedItems.length === 0}
                    onClick={openEditModal}
                  >
                    Edit
                  </Button>
                  <Button variant="primary" onClick={openCreateModal}>
                    Create policy
                  </Button>
                </SpaceBetween>
              }
            >
              Policies
            </Header>
          }
        />
      </ContentLayout>

      <Modal
        visible={modalMode !== null}
        onDismiss={() => setModalMode(null)}
        header={modalMode === "create" ? "Create policy" : "Edit policy"}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setModalMode(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={submitting}
                onClick={handleSubmit}
                disabled={loadingResources}
              >
                {modalMode === "create" ? "Create" : "Save changes"}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {loadingResources ? (
          <Box textAlign="center" padding="l">
            <Spinner size="large" />
            <Box variant="p" padding={{ top: "s" }}>
              Loading AWS resources…
            </Box>
          </Box>
        ) : (
          <SpaceBetween size="m">
            {resourcesError && <Alert type="error">{resourcesError}</Alert>}
            <Form errorText={formError ?? undefined}>
              <SpaceBetween size="l">
                <FormField label="Name" errorText={nameError}>
                  <Input
                    value={formValues.name}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({ ...prev, name: detail.value }))
                    }
                    placeholder="Enter policy name"
                  />
                </FormField>

                <FormField label="Description — optional">
                  <Input
                    value={formValues.description}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({ ...prev, description: detail.value }))
                    }
                    placeholder="Enter a short description"
                  />
                </FormField>

                <FormField label="Principal type">
                  <Select
                    selectedOption={formValues.principalType}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({
                        ...prev,
                        principalType: detail.selectedOption,
                        principal: null,
                      }))
                    }
                    options={PRINCIPAL_TYPE_OPTIONS}
                  />
                </FormField>

                <FormField label="User or Group" errorText={principalError}>
                  <Select
                    selectedOption={formValues.principal}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({
                        ...prev,
                        principal: detail.selectedOption,
                      }))
                    }
                    options={principalOptions}
                    filteringType="auto"
                    placeholder={`Select a ${formValues.principalType.value === "GROUP" ? "group" : "user"}`}
                    empty="No results found"
                  />
                </FormField>

                <FormField
                  label="Accounts"
                  description="Users will have access to all selected accounts."
                >
                  <Multiselect
                    selectedOptions={formValues.accounts}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({
                        ...prev,
                        accounts: detail.selectedOptions,
                      }))
                    }
                    options={awsResources.accounts}
                    filteringType="auto"
                    placeholder="Select accounts"
                    empty="No accounts found"
                  />
                </FormField>

                <FormField
                  label="Organization Units (OUs)"
                  description="Users will have access to all accounts within the selected OUs."
                >
                  <Multiselect
                    selectedOptions={formValues.ous}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({
                        ...prev,
                        ous: detail.selectedOptions,
                      }))
                    }
                    options={awsResources.ous}
                    filteringType="auto"
                    placeholder="Select OUs"
                    empty="No OUs found"
                  />
                </FormField>

                <FormField label="Permission Sets" errorText={permissionSetError}>
                  <Multiselect
                    selectedOptions={formValues.permissionSets}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({
                        ...prev,
                        permissionSets: detail.selectedOptions,
                      }))
                    }
                    options={awsResources.permissionSets}
                    filteringType="auto"
                    placeholder="Select permission sets"
                    empty="No permission sets found"
                  />
                </FormField>

                <FormField
                  label="Max Duration"
                  description="Date and time that defines the maximum access duration. The duration is calculated from today to the selected date and time (up to 1 year). Defaults to end of today if left blank."
                  errorText={maxDurationError}
                >
                  <SpaceBetween direction="horizontal" size="xs">
                    <DatePicker
                      value={formValues.maxDurationDate}
                      onChange={({ detail }) =>
                        setFormValues((prev) => ({ ...prev, maxDurationDate: detail.value }))
                      }
                      placeholder="YYYY/MM/DD"
                      isDateEnabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const maxDate = new Date(today.getTime() + 365 * 86400000);
                        return date >= today && date <= maxDate;
                      }}
                    />
                    <TimeInput
                      format="hh:mm"
                      placeholder="hh:mm"
                      use24Hour={true}
                      value={formValues.maxDurationTime}
                      onChange={({ detail }) =>
                        setFormValues((prev) => ({ ...prev, maxDurationTime: detail.value }))
                      }
                      disabled={!formValues.maxDurationDate}
                    />
                  </SpaceBetween>
                </FormField>

                <FormField
                  label="Require approval"
                  description="When enabled, access requests under this policy must be approved before access is granted."
                >
                  <Toggle
                    checked={formValues.requiresApproval}
                    onChange={({ detail }) =>
                      setFormValues((prev) => ({ ...prev, requiresApproval: detail.checked }))
                    }
                  >
                    {formValues.requiresApproval ? "Approval required" : "No approval required"}
                  </Toggle>
                </FormField>
              </SpaceBetween>
            </Form>
          </SpaceBetween>
        )}
      </Modal>
    </>
  );
}
