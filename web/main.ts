import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import AuthView from "./views/AuthView.vue";
import DocumentsView from "./views/DocumentsView.vue";
import { refreshUser, currentUser } from "./api";
import "@fontsource-variable/dm-sans";
import "./style.css";

// Sign-in and the document list load with the app. Every other page, and the
// PDF, drawing and QR libraries they use, loads when it is first opened.
const SignaturesView = () => import("./views/SignaturesView.vue");
const EditorView = () => import("./views/EditorView.vue");
const SignView = () => import("./views/SignView.vue");
const AdminView = () => import("./views/AdminView.vue");
const JoinView = () => import("./views/JoinView.vue");
const AccountView = () => import("./views/AccountView.vue");
const PrivacyView = () => import("./views/PrivacyView.vue");
const AdminOperationsView = () => import("./views/AdminOperationsView.vue");

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/documents" },
    { path: "/login", component: AuthView, meta: { public: true } },
    { path: "/register", component: AuthView, meta: { public: true } },
    { path: "/forgot-password", component: AuthView, meta: { public: true } },
    { path: "/reset-password", component: AuthView, meta: { public: true } },
    { path: "/account", component: AccountView },
    { path: "/privacy", component: PrivacyView },
    { path: "/documents", component: DocumentsView },
    { path: "/documents/:id", component: EditorView },
    { path: "/signatures", component: SignaturesView },
    { path: "/admin", component: AdminView, meta: { admin: true } },
    {
      path: "/admin/operations",
      component: AdminOperationsView,
      meta: { admin: true },
    },
    { path: "/join/:token", component: JoinView, meta: { public: true } },
    { path: "/sign/:token", component: SignView, meta: { public: true } },
    { path: "/:pathMatch(.*)*", redirect: "/documents" },
  ],
});
let initialized = false;
router.beforeEach(async (to) => {
  if (!initialized || to.meta.admin) {
    await refreshUser().catch(() => {
      currentUser.value = null;
    });
    initialized = true;
  }
  if (!to.meta.public && !currentUser.value)
    return { path: "/login", query: { next: to.fullPath } };
  if (to.meta.admin && currentUser.value?.role !== "admin") return "/documents";
  if (
    to.meta.admin &&
    (!currentUser.value?.emailVerified ||
      !currentUser.value?.twoFactorEnabled ||
      !currentUser.value?.mfaVerified)
  )
    return { path: "/account", query: { next: to.fullPath } };
  if (["/login", "/register"].includes(to.path) && currentUser.value)
    return "/documents";
});

// After a deployment, an open tab may ask for page code that no longer
// exists. Load the requested page fresh, at most once every ten seconds.
const RELOAD_KEY = "papersign-stale-code-reload";
function reloadForNewRelease(path: string) {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  } catch {
    /* storage unavailable: still reload once */
  }
  if (Date.now() - last < 10_000) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
  window.location.assign(path);
  return true;
}
router.onError((error, to) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/dynamically imported module|module script failed/i.test(message))
    reloadForNewRelease(to.fullPath);
});
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewRelease(window.location.href)) event.preventDefault();
});

createApp(App).use(router).mount("#app");
