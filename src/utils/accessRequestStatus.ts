import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";

export function accessRequestStatusType(
  status: string | null | undefined
): StatusIndicatorProps.Type {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "REVOKED":
    case "EXPIRED":
      return "stopped";
    case "FAILED":
    case "REJECTED":
      return "error";
    case "PENDING_APPROVAL":
      return "warning";
    case "SCHEDULED":
      return "info";
    default:
      return "pending";
  }
}
