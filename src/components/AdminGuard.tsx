import { GroupGuard } from "./GroupGuard";

type Props = { children: React.ReactNode };

/**
 * Gates admin-only pages to the "Admins" Cognito group.
 * Thin wrapper over the generalized {@link GroupGuard}.
 */
export function AdminGuard({ children }: Props) {
  return <GroupGuard group="Admins">{children}</GroupGuard>;
}
