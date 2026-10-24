// State shared by the Admin page and its sections: the URL-backed location,
// the page-wide busy flag and messages, and access handling.
import {
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import type { LocationQuery } from "vue-router";
import type {
  AccountInvitation,
  AdminApiKey,
  AdminDocument,
  AdminUser,
} from "../../../shared/admin-types";

/** Row type returned by each Admin list endpoint. */
export interface AdminRows {
  users: AdminUser;
  documents: AdminDocument;
  "account-invitations": AccountInvitation;
  "api-keys": AdminApiKey;
}

export type Tab = "Users" | "Invitations" | "Documents" | "API keys";
export const tabs: Tab[] = ["Users", "Invitations", "Documents", "API keys"];
export interface AdminLocation {
  tab: Tab;
  query: string;
  page: number;
  ownerId: string;
}
export const PAGE_SIZE = 25;

const sectionSlug = (value: Tab) => value.toLowerCase().replace(" ", "-");

export function readLocation(params: LocationQuery): AdminLocation {
  const single = (key: string) =>
    typeof params[key] === "string" ? params[key] : "";
  const selected = tabs.find(
    (value) => sectionSlug(value) === single("section"),
  );
  const requestedPage = Number(single("page"));
  const ownerId = single("userId");
  return {
    tab: selected ?? "Users",
    query: single("search").trim().slice(0, 100),
    page:
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? Math.min(requestedPage, 100_000)
        : 1,
    ownerId:
      selected === "Documents" && /^[\w-]{1,128}$/.test(ownerId) ? ownerId : "",
  };
}
export function locationQuery(value: AdminLocation) {
  const params: Record<string, string> = {};
  if (value.tab !== "Users") params.section = sectionSlug(value.tab);
  if (value.query) params.search = value.query;
  if (value.page !== 1) params.page = String(value.page);
  if (value.tab === "Documents" && value.ownerId) params.userId = value.ownerId;
  return params;
}

export interface AdminContext {
  location: ComputedRef<AdminLocation>;
  /** One action at a time: disables tabs, lists and section controls. */
  busy: Ref<boolean>;
  error: Ref<string>;
  notice: Ref<string>;
  /** The visible list registers its loader so actions can reload and wait. */
  registerList(load: () => Promise<void>): () => void;
  reloadList(): Promise<void>;
  /** Owner shown on the filtered Documents list before its rows arrive. */
  owner: Ref<AdminDocument["owner"] | undefined>;
  /** A section asks for focus here after navigation, e.g. "invite-name". */
  focusRequest: Ref<string | null>;
  navigate(value: AdminLocation): Promise<void>;
  failure(error: unknown): Promise<void>;
  checkAccess(error: unknown, isCurrent?: () => boolean): Promise<void>;
  reloadStatistics(): Promise<void>;
  /** Clears the page error and reloads statistics and the current list. */
  refresh(): Promise<void>;
}

const key: InjectionKey<AdminContext> = Symbol("admin");
export const provideAdminContext = (context: AdminContext) =>
  provide(key, context);
export function useAdminContext() {
  const context = inject(key);
  if (!context)
    throw new Error("Admin sections must be used inside AdminView.");
  return context;
}
