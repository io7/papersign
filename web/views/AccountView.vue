<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { Check, Download, ShieldCheck } from "@lucide/vue";
import CopyField from "../components/CopyField.vue";
import { api, errorMessage, json, refreshUser } from "../api";
type Security = {
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  mfaVerified: boolean;
  admin: boolean;
  emailEnabled: boolean;
  sessions: {
    id: string;
    current: boolean;
    createdAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }[];
};
const route = useRoute();
const security = ref<Security | null>(null),
  loading = ref(true),
  busy = ref("");
const error = ref(""),
  notice = ref("");
const password = ref(""),
  code = ref(""),
  recovery = ref(false),
  saved = ref(false);
const totpURI = ref(""),
  qrCode = ref(""),
  backupCodes = ref<string[]>([]);
const setupKey = computed(() =>
  totpURI.value
    ? (new URL(totpURI.value).searchParams.get("secret") ?? "")
    : "",
);
async function load() {
  security.value = await api<Security>("/account/security");
}
onMounted(async () => {
  try {
    await load();
    if (route.query.error)
      error.value =
        "The verification link is invalid or has expired. Send a new link below.";
    else if (route.query.verified && security.value?.emailVerified)
      notice.value = "Your email address is verified.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
async function action(key: string, work: () => Promise<void>) {
  busy.value = key;
  error.value = "";
  notice.value = "";
  try {
    await work();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = "";
  }
}
async function verifyEmail() {
  await action("email", async () => {
    await api("/account/verify-email", { method: "POST" });
    notice.value =
      "A verification link has been requested. Check your inbox and spam folder, then reopen Account security.";
  });
}
async function enable() {
  await action("enable", async () => {
    const result = await api("/auth/two-factor/enable", {
      method: "POST",
      body: json({ password: password.value, method: "totp" }),
    });
    password.value = "";
    totpURI.value = result.totpURI;
    backupCodes.value = result.backupCodes;
    saved.value = false;
    recovery.value = false;
    qrCode.value = "";
    try {
      const { default: QRCode } = await import("qrcode");
      qrCode.value = await QRCode.toDataURL(result.totpURI, {
        errorCorrectionLevel: "M",
        margin: 4,
        width: 448,
      });
    } catch {
      // Enrollment is already pending. Manual entry must remain available.
      notice.value =
        "The QR code could not be displayed. Use the setup key below.";
    }
  });
}
async function confirmFactor() {
  await action("verify", async () => {
    await api(
      recovery.value
        ? "/auth/two-factor/verify-backup-code"
        : "/auth/two-factor/verify-totp",
      {
        method: "POST",
        body: json({ code: code.value.trim(), trustDevice: false }),
      },
    );
    code.value = "";
    totpURI.value = "";
    qrCode.value = "";
    backupCodes.value = [];
    saved.value = false;
    await load();
    await refreshUser();
    notice.value =
      "Two-step verification confirmed. This session is protected.";
  });
}
async function regenerateCodes() {
  await action("recovery", async () => {
    const result = await api("/auth/two-factor/generate-backup-codes", {
      method: "POST",
      body: json({ password: password.value }),
    });
    password.value = "";
    backupCodes.value = result.backupCodes;
    saved.value = false;
    notice.value =
      "Your previous recovery codes no longer work. Save these new codes before leaving.";
  });
}
function downloadCodes() {
  const url = URL.createObjectURL(
    new Blob(
      [
        `PaperSign recovery codes\nAccount: ${security.value?.email}\n\nEach code can be used once. Store these somewhere safe, separate from your password.\n\n${backupCodes.value.join("\n")}\n`,
      ],
      { type: "text/plain" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "papersign-recovery-codes.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function revoke(id?: string) {
  await action(id ?? "others", async () => {
    await api(
      id
        ? `/account/sessions/${encodeURIComponent(id)}/revoke`
        : "/account/sessions/revoke-others",
      { method: "POST" },
    );
    await load();
    notice.value = id
      ? "That session has been signed out."
      : "All other sessions have been signed out.";
  });
}
const sessionTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function device(agent: string | null) {
  if (!agent) return "Unidentified browser";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const system = /Android/.test(agent)
    ? "Android"
    : /iPhone|iPad/.test(agent)
      ? "iOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "unknown device";
  return `${browser} on ${system}`;
}
</script>
<template>
  <div class="page account-page">
    <header class="page-heading">
      <div>
        <h1>Account security</h1>
        <p class="muted">
          Protect your account and manage where you are signed in.
        </p>
      </div>
    </header>
    <p v-if="loading" class="muted" role="status">
      Loading your security settings…
    </p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <template v-if="security">
      <div
        v-if="
          security.admin &&
          (!security.twoFactorEnabled || !security.mfaVerified)
        "
        class="notice admin-guidance"
      >
        <ShieldCheck :size="22" aria-hidden="true" />
        <div>
          <strong>Protect your Admin access</strong>
          <p>
            Set up or confirm your authenticator below to open Admin. Your
            account and documents remain available.
          </p>
        </div>
      </div>
      <div class="security-settings">
        <section class="security-section" aria-labelledby="email-heading">
          <div class="security-description">
            <h2 id="email-heading">Email address</h2>
            <p class="muted">
              Verify your address before signing documents or inviting others.
            </p>
          </div>
          <div class="security-controls">
            <p class="account-email">{{ security.email }}</p>
            <p v-if="security.emailVerified" class="verified-label">
              <Check :size="17" />Verified
            </p>
            <template v-else
              ><p class="muted">Your address has not been verified.</p>
              <button
                class="button secondary"
                :disabled="Boolean(busy) || !security.emailEnabled"
                @click="verifyEmail"
              >
                {{
                  busy === "email"
                    ? "Requesting link…"
                    : "Send verification link"
                }}
              </button>
              <p v-if="!security.emailEnabled" class="hint">
                Email delivery is not configured. Contact the administrator.
              </p></template
            >
          </div>
        </section>
        <section class="security-section" aria-labelledby="factor-heading">
          <div class="security-description">
            <h2 id="factor-heading">Two-step verification</h2>
            <p class="muted">
              Use an authenticator app alongside your password. Required for
              Admin access.
            </p>
          </div>
          <div class="security-controls">
            <p v-if="security.twoFactorEnabled" class="verified-label">
              <ShieldCheck :size="18" />Authenticator enabled
            </p>
            <form
              v-if="!security.twoFactorEnabled && !totpURI"
              @submit.prevent="enable"
            >
              <label class="field"
                >Current password<input
                  v-model="password"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxlength="128" /></label
              ><button class="button primary" :disabled="Boolean(busy)">
                {{ busy === "enable" ? "Preparing…" : "Set up authenticator" }}
              </button>
            </form>
            <div v-if="totpURI" class="setup-details">
              <h3>1. Scan the QR code</h3>
              <p class="muted">
                Open your authenticator app, add an account and scan this code.
              </p>
              <img
                v-if="qrCode"
                :src="qrCode"
                class="authenticator-qr"
                width="224"
                height="224"
                alt="Scan this QR code with your authenticator app"
              />
              <p class="authenticator-link">
                <a :href="totpURI"
                  >Open in an authenticator app on this device</a
                >
              </p>
              <details class="manual-setup" :open="!qrCode">
                <summary>Can’t scan the code? Enter a setup key</summary>
                <p class="muted">
                  Use your email address as the account name and select
                  time-based codes.
                </p>
                <CopyField
                  :value="setupKey"
                  label="Setup key"
                  copy-label="Copy"
                  copied-message="Setup key copied."
                  failure-message="Could not copy the key. Select and copy it from the box."
                  monospace
                  stacked
                />
              </details>
            </div>
            <div v-if="backupCodes.length" class="recovery-details">
              <h3>
                {{
                  totpURI
                    ? "2. Save your recovery codes"
                    : "Save your recovery codes"
                }}
              </h3>
              <p class="muted">
                Each code works once if you lose access to your authenticator.
                Store them separately from your password.
              </p>
              <ul class="recovery-codes" aria-label="Recovery codes">
                <li v-for="item in backupCodes" :key="item">{{ item }}</li>
              </ul>
              <button
                class="button secondary"
                type="button"
                @click="downloadCodes"
              >
                <Download :size="17" />Download recovery codes</button
              ><label v-if="totpURI" class="consent-label"
                ><input v-model="saved" type="checkbox" /><span
                  >I have saved my recovery codes.</span
                ></label
              >
            </div>
            <form
              v-if="
                totpURI || (security.twoFactorEnabled && !security.mfaVerified)
              "
              class="factor-confirm"
              @submit.prevent="confirmFactor"
            >
              <h3 v-if="totpURI">3. Confirm your authenticator</h3>
              <label class="field"
                >{{ recovery ? "Recovery code" : "Authenticator code"
                }}<input
                  v-model="code"
                  :inputmode="recovery ? 'text' : 'numeric'"
                  autocomplete="one-time-code"
                  :pattern="recovery ? undefined : '[0-9]{6}'"
                  :maxlength="recovery ? 32 : 6"
                  required /></label
              ><button
                v-if="!totpURI"
                type="button"
                class="text-button"
                @click="
                  recovery = !recovery;
                  code = '';
                "
              >
                {{
                  recovery ? "Use my authenticator" : "Use a recovery code"
                }}</button
              ><button
                class="button primary"
                :disabled="Boolean(busy) || (Boolean(totpURI) && !saved)"
              >
                {{
                  busy === "verify"
                    ? "Confirming…"
                    : totpURI
                      ? "Confirm and enable"
                      : "Confirm this session"
                }}
              </button>
            </form>
            <details
              v-if="security.twoFactorEnabled && security.mfaVerified"
              class="recovery-settings"
            >
              <summary>Replace recovery codes</summary>
              <p class="muted">
                New codes immediately replace your previous recovery codes.
              </p>
              <form @submit.prevent="regenerateCodes">
                <label class="field"
                  >Current password<input
                    v-model="password"
                    type="password"
                    autocomplete="current-password"
                    required
                    maxlength="128" /></label
                ><button class="button secondary" :disabled="Boolean(busy)">
                  {{
                    busy === "recovery"
                      ? "Replacing…"
                      : "Generate new recovery codes"
                  }}
                </button>
              </form>
            </details>
            <RouterLink
              v-if="
                security.admin && security.mfaVerified && security.emailVerified
              "
              class="button primary"
              to="/admin"
              >Open Admin</RouterLink
            >
          </div>
        </section>
        <section class="security-section" aria-labelledby="password-heading">
          <div class="security-description">
            <h2 id="password-heading">Password</h2>
            <p class="muted">
              Resetting your password signs out every active session. Your
              authenticator stays enabled.
            </p>
          </div>
          <div class="security-controls">
            <RouterLink class="button secondary" to="/forgot-password"
              >Reset password</RouterLink
            >
          </div>
        </section>
        <section class="security-section" aria-labelledby="sessions-heading">
          <div class="security-description">
            <h2 id="sessions-heading">Active sessions</h2>
            <p class="muted">
              Sign out browsers you no longer use or do not recognize.
            </p>
          </div>
          <div class="security-controls">
            <ul class="session-list">
              <li v-for="item in security.sessions" :key="item.id">
                <div>
                  <strong>{{ device(item.userAgent) }}</strong
                  ><span v-if="item.current" class="current-session"
                    >This browser</span
                  >
                  <p class="hint">
                    Signed in {{ sessionTime(item.createdAt) }}<br />{{
                      item.ipAddress || "Address unavailable"
                    }}
                  </p>
                </div>
                <button
                  v-if="!item.current"
                  class="text-button danger-text"
                  :disabled="Boolean(busy)"
                  @click="revoke(item.id)"
                >
                  {{ busy === item.id ? "Signing out…" : "Sign out" }}
                </button>
              </li>
            </ul>
            <button
              class="button secondary"
              :disabled="Boolean(busy) || security.sessions.length < 2"
              @click="revoke()"
            >
              {{
                busy === "others"
                  ? "Signing out…"
                  : "Sign out all other sessions"
              }}
            </button>
          </div>
        </section>
      </div>
    </template>
    <button
      v-else-if="!loading"
      class="button secondary"
      @click="action('retry', load)"
    >
      Try again
    </button>
  </div>
</template>
<style scoped>
.account-page {
  max-width: 1180px;
}
.account-page .page-heading {
  margin-bottom: 28px;
}
.admin-guidance {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 20px;
  margin-bottom: 24px;
}
.admin-guidance p {
  margin-top: 4px;
}
.security-settings {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0 32px;
}
.security-section {
  display: grid;
  grid-template-columns: minmax(180px, 0.7fr) minmax(0, 1.3fr);
  gap: 40px;
  padding: 32px 0;
  border-top: 1px solid var(--line);
}
.security-section:first-child {
  border-top: 0;
}
.security-section h2 {
  margin: 0 0 8px;
  font-size: 21px;
}
.security-section h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.security-description p,
.security-controls p {
  margin: 0 0 16px;
}
.security-description p {
  font-size: 14px;
}
.security-controls {
  min-width: 0;
}
.security-controls .field {
  margin: 0 0 16px;
  max-width: 420px;
}
.security-controls .button {
  white-space: normal;
  text-align: center;
  max-width: 100%;
}
.account-email {
  overflow-wrap: anywhere;
  font-weight: 570;
}
.verified-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--green);
}
.setup-details,
.recovery-details,
.factor-confirm {
  padding-top: 24px;
  margin-top: 24px;
  border-top: 1px solid var(--line);
}
.setup-details {
  padding-top: 0;
  margin-top: 0;
  border-top: 0;
}
.authenticator-qr {
  display: block;
  width: 224px;
  height: auto;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.security-controls .authenticator-link {
  margin-top: 16px;
  font-size: 14px;
}
.manual-setup {
  font-size: 14px;
}
.manual-setup summary,
.recovery-settings summary {
  cursor: pointer;
  color: var(--green);
  padding: 8px 0;
}
.manual-setup[open] summary {
  margin-bottom: 12px;
}
.setup-details a {
  overflow-wrap: anywhere;
}
.recovery-codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 16px;
  background: var(--soft);
  border-radius: 8px;
  list-style: none;
  font-family: monospace;
  font-size: 14px;
  overflow-wrap: anywhere;
  margin: 0 0 16px;
}
.consent-label {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  margin-top: 20px;
  padding: 8px 0;
  cursor: pointer;
  line-height: 24px;
}
.consent-label input {
  margin: 3px 0 0;
}
.factor-confirm .button {
  display: flex;
  margin-top: 16px;
}
.recovery-settings {
  margin: 16px 0 24px;
}
.recovery-settings p {
  margin-top: 8px;
}
.session-list {
  list-style: none;
  padding: 0;
  margin: 0 0 20px;
}
.session-list li {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.session-list li:first-child {
  padding-top: 0;
}
.current-session {
  display: inline-block;
  color: var(--green);
  font-size: 12px;
  margin-left: 10px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--soft);
}
.session-list .hint {
  margin-bottom: 0;
}
@media (max-width: 1000px) {
  .security-settings {
    padding: 0 24px;
  }
  .security-section {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 24px 0;
  }
  .security-description p {
    margin-bottom: 0;
  }
}
@media (max-width: 480px) {
  .security-settings {
    padding: 0 20px;
  }
  .recovery-codes {
    font-size: 13px;
    padding: 12px;
  }
  .current-session {
    display: table;
    margin: 8px 0 0;
  }
}
</style>
