import type { UserRole } from "../../../shared/admin-types";

export function size(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
export function roleName(role: UserRole) {
  return role === "admin" ? "Admin" : "User";
}
export function statusName(status: string) {
  return status === "awaiting"
    ? "Awaiting signatures"
    : status.charAt(0).toUpperCase() + status.slice(1);
}
