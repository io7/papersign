<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Feather, ArrowRight } from "@lucide/vue";
import {
  api,
  currentUser,
  errorMessage,
  formatDate,
  json,
  refreshUser,
} from "../api";
import type { AccountInvitationPreview } from "../../shared/admin-types";

const route = useRoute();
const router = useRouter();
const token = computed(() => String(route.params.token ?? ""));
const invitation = ref<AccountInvitationPreview | null>(null);
const loading = ref(true);
const loadError = ref("");
const error = ref("");
const name = ref("");
const password = ref("");
const busy = ref(false);
const signInRequired = ref(false);
const accepted = ref(false);
const created = ref(false);
const matchingAccount = computed(
  () =>
    currentUser.value?.email.toLowerCase() ===
    invitation.value?.email.toLowerCase(),
);
const signInRoute = computed(() => ({
  path: "/login",
  query: { next: `/join/${token.value}` },
}));

let loadGeneration = 0;
let mounted = true;
const isCurrentInvitation = (generation: number, invitationToken: string) =>
  mounted && generation === loadGeneration && token.value === invitationToken;
onBeforeUnmount(() => {
  mounted = false;
  loadGeneration++;
});
watch(
  token,
  async (value) => {
    const generation = ++loadGeneration;
    loading.value = true;
    loadError.value = "";
    error.value = "";
    invitation.value = null;
    name.value = "";
    password.value = "";
    busy.value = false;
    signInRequired.value = false;
    accepted.value = false;
    created.value = false;
    try {
      const [preview] = await Promise.all([
        api<AccountInvitationPreview>(
          `/account-invitations/${encodeURIComponent(value)}`,
        ),
        refreshUser(),
      ]);
      if (!isCurrentInvitation(generation, value)) return;
      invitation.value = preview;
      name.value = preview.name;
    } catch (e) {
      if (isCurrentInvitation(generation, value))
        loadError.value = errorMessage(e);
    } finally {
      if (isCurrentInvitation(generation, value)) loading.value = false;
    }
  },
  { immediate: true },
);

async function acceptInvitation() {
  if (busy.value || accepted.value || !invitation.value) return;
  if (currentUser.value && !matchingAccount.value) return;
  const request = {
    generation: loadGeneration,
    token: token.value,
    name: name.value.trim(),
    password: password.value,
    invitation: { ...invitation.value },
    user: currentUser.value ? { ...currentUser.value } : null,
  };
  const isCurrent = () =>
    isCurrentInvitation(request.generation, request.token);
  const creatingAccount = !request.user;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/account-invitations/${encodeURIComponent(request.token)}/accept`,
      {
        method: "POST",
        body: json(
          creatingAccount
            ? { name: request.name, password: request.password }
            : {},
        ),
      },
    );
    if (!isCurrent()) return;
    // Acceptance is complete even if the following sign-in request fails.
    // Hide the form now so a retry cannot attempt to consume the invite again.
    accepted.value = true;
    created.value = creatingAccount;
    password.value = "";
    try {
      if (creatingAccount) {
        await api("/auth/sign-in/email", {
          method: "POST",
          body: json({
            email: request.invitation.email,
            password: request.password,
          }),
        });
        if (!isCurrent()) return;
      }
      await refreshUser();
      if (!isCurrent()) return;
      await router.push("/documents");
    } catch {
      // The accepted state below offers the ordinary sign-in flow.
    }
  } catch (e) {
    if (!isCurrent()) return;
    if (
      e !== null &&
      typeof e === "object" &&
      "status" in e &&
      e.status === 409
    ) {
      await refreshUser().catch(() => {});
      if (!isCurrent()) return;
      signInRequired.value = !currentUser.value;
      password.value = "";
    }
    error.value = errorMessage(e);
  } finally {
    if (isCurrent()) busy.value = false;
  }
}

async function signOut() {
  if (busy.value) return;
  const generation = loadGeneration;
  const invitationToken = token.value;
  busy.value = true;
  error.value = "";
  try {
    await api("/auth/sign-out", { method: "POST", body: json({}) });
    await refreshUser();
  } catch (e) {
    if (isCurrentInvitation(generation, invitationToken))
      error.value = errorMessage(e);
  } finally {
    if (isCurrentInvitation(generation, invitationToken)) busy.value = false;
  }
}
</script>

<template>
  <div class="auth-page join-page">
    <div class="auth-story">
      <RouterLink class="brand" to="/">
        <Feather :size="30" />
        <span>PaperSign<span class="brand-dot">.</span></span>
      </RouterLink>
      <div class="auth-intro">
        <h1>Join PaperSign.</h1>
        <p>Accept your invitation to get started.</p>
      </div>
      <p class="auth-foot">A little less paperwork.</p>
    </div>

    <main class="auth-form-area" :aria-busy="loading || busy">
      <div class="auth-form">
        <p v-if="loading" class="muted" role="status">
          Loading your invitation…
        </p>
        <template v-else-if="loadError">
          <h2>Invitation unavailable</h2>
          <p class="notice error" role="alert">{{ loadError }}</p>
          <p class="muted">Ask the person who invited you for a new link.</p>
          <RouterLink class="button secondary" to="/login">Sign in</RouterLink>
        </template>
        <template v-else-if="accepted">
          <h2>{{ created ? "Account created" : "Invitation accepted" }}</h2>
          <p class="muted">Sign in with {{ invitation?.email }} to continue.</p>
          <RouterLink class="button primary auth-submit" to="/login">
            Sign in<ArrowRight :size="18" />
          </RouterLink>
        </template>
        <template v-else-if="invitation">
          <h2>Your invitation</h2>
          <dl class="join-details">
            <div>
              <dt>Email address</dt>
              <dd>{{ invitation.email }}</dd>
            </div>
            <div>
              <dt>Account role</dt>
              <dd>{{ invitation.role === "admin" ? "Admin" : "User" }}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{{ formatDate(invitation.expiresAt) }}</dd>
            </div>
          </dl>

          <template v-if="currentUser && !matchingAccount">
            <p class="notice">
              You are signed in as <strong>{{ currentUser.email }}</strong
              >. Sign out to accept the invitation for
              <strong>{{ invitation.email }}</strong
              >.
            </p>
            <p v-if="error" class="notice error" role="alert">{{ error }}</p>
            <button
              class="button secondary auth-submit"
              :disabled="busy"
              @click="signOut"
            >
              {{ busy ? "Signing out…" : "Sign out" }}
            </button>
          </template>
          <form v-else-if="currentUser" @submit.prevent="acceptInvitation">
            <p class="muted">
              You are signed in as {{ currentUser.email }}. Accept this
              invitation with your existing account.
            </p>
            <p v-if="error" class="notice error" role="alert">{{ error }}</p>
            <button class="button primary auth-submit" :disabled="busy">
              {{ busy ? "Accepting…" : "Accept invitation" }}
              <ArrowRight :size="18" />
            </button>
          </form>
          <template v-else-if="signInRequired">
            <p class="notice" role="status">{{ error }}</p>
            <RouterLink class="button primary auth-submit" :to="signInRoute">
              Sign in<ArrowRight :size="18" />
            </RouterLink>
          </template>
          <template v-else>
            <form @submit.prevent="acceptInvitation">
              <label class="field">
                Your name
                <input
                  v-model="name"
                  autocomplete="name"
                  required
                  maxlength="100"
                  :disabled="busy"
                />
              </label>
              <label class="field">
                <span id="join-password-label">Password</span>
                <input
                  v-model="password"
                  type="password"
                  autocomplete="new-password"
                  aria-labelledby="join-password-label"
                  aria-describedby="join-password-hint"
                  required
                  minlength="12"
                  maxlength="128"
                  :disabled="busy"
                />
                <span id="join-password-hint" class="hint">
                  Use at least 12 characters.
                </span>
              </label>
              <p v-if="error" class="notice error" role="alert">{{ error }}</p>
              <button class="button primary auth-submit" :disabled="busy">
                {{ busy ? "Creating account…" : "Create account" }}
                <ArrowRight :size="18" />
              </button>
            </form>
            <p class="auth-switch">
              Already have an account?
              <RouterLink :to="signInRoute">Sign in</RouterLink>
            </p>
          </template>
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
.join-details {
  display: grid;
  gap: 16px;
  margin: 24px 0 32px;
}
.join-details dt {
  color: var(--muted);
  font-size: 13px;
}
.join-details dd {
  margin: 4px 0 0;
  font-weight: 570;
}
.join-page .auth-form {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
