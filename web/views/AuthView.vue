<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Feather, ArrowRight, Check } from "@lucide/vue";
import { api, json, refreshUser, errorMessage } from "../api";
const route = useRoute(),
  router = useRouter();
const register = computed(() => route.path === "/register");
const forgot = computed(() => route.path === "/forgot-password");
const reset = computed(() => route.path === "/reset-password");
const name = ref(""),
  email = ref(""),
  password = ref(""),
  confirmPassword = ref("");
const busy = ref(false),
  error = ref(""),
  notice = ref("");
const registrationEnabled = ref(true),
  emailEnabled = ref(false);
const secondFactor = ref(false),
  recovery = ref(false),
  rememberBrowser = ref(false),
  code = ref("");
const resetToken = ref(String(route.query.token ?? ""));
const title = computed(() =>
  secondFactor.value
    ? "Confirm it's you"
    : reset.value
      ? "Choose a new password"
      : forgot.value
        ? "Reset your password"
        : register.value
          ? "Create your account"
          : "Welcome back",
);
const description = computed(() =>
  secondFactor.value
    ? recovery.value
      ? "Enter one of your saved recovery codes."
      : "Enter the six-digit code from your authenticator app."
    : reset.value
      ? "Your other sessions will be signed out. Your authenticator stays enabled."
      : forgot.value
        ? "We'll email you a private link to choose a new password."
        : register.value
          ? "A home for your documents and signatures."
          : "Your signatures are right where you left them.",
);
onMounted(async () => {
  try {
    const settings = await api("/config");
    registrationEnabled.value = settings.registrationEnabled;
    emailEnabled.value = settings.emailEnabled;
  } catch (e) {
    error.value = errorMessage(e);
  }
  if (reset.value && route.query.token) {
    const query = { ...route.query };
    delete query.token;
    await router.replace({ path: route.path, query });
  }
  if (reset.value && !resetToken.value)
    error.value =
      "This reset link is invalid or has expired. Request a new one.";
});
watch(
  () => route.path,
  () => {
    error.value = "";
    notice.value = "";
    password.value = "";
    confirmPassword.value = "";
    secondFactor.value = false;
    code.value = "";
  },
);
async function finishLogin() {
  const user = await refreshUser();
  if (!user) throw new Error("Your sign-in expired. Please sign in again.");
  const next = String(route.query.next ?? "/documents");
  await router.push(
    next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")
      ? next
      : "/documents",
  );
}
async function submit() {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (secondFactor.value) {
      await api(
        recovery.value
          ? "/auth/two-factor/verify-backup-code"
          : "/auth/two-factor/verify-totp",
        {
          method: "POST",
          // Only an authenticator code may remember the browser.
          body: json({
            code: code.value.trim(),
            trustDevice: !recovery.value && rememberBrowser.value,
          }),
        },
      );
      code.value = "";
      await finishLogin();
      return;
    }
    if (forgot.value) {
      await api("/auth/request-password-reset", {
        method: "POST",
        body: json({
          email: email.value.trim(),
          redirectTo: `${location.origin}/reset-password`,
        }),
      });
      notice.value =
        "If an account uses this address, a reset link will arrive shortly. Check your spam folder too.";
      return;
    }
    if (reset.value) {
      if (password.value !== confirmPassword.value)
        throw new Error("The passwords do not match.");
      await api("/auth/reset-password", {
        method: "POST",
        body: json({ token: resetToken.value, newPassword: password.value }),
      });
      await refreshUser();
      resetToken.value = "";
      password.value = "";
      confirmPassword.value = "";
      notice.value =
        "Your password has been reset. Sign in with your new password.";
      return;
    }
    const result = await api(
      register.value ? "/auth/sign-up/email" : "/auth/sign-in/email",
      {
        method: "POST",
        body: json({
          name: name.value.trim(),
          email: email.value.trim(),
          password: password.value,
          callbackURL: `${location.origin}/account?verified=1`,
        }),
      },
    );
    password.value = "";
    if (register.value) {
      notice.value = emailEnabled.value
        ? "Check your inbox for a verification link, then sign in. If you already have an account, sign in or reset your password."
        : "You can now sign in. Email delivery must be configured before you can verify your address and sign documents.";
      return;
    }
    if (result.twoFactorRedirect) {
      secondFactor.value = true;
      return;
    }
    await finishLogin();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="auth-page">
    <div class="auth-story">
      <RouterLink class="brand" to="/"
        ><Feather :size="30" /><span
          >PaperSign<span class="brand-dot">.</span></span
        ></RouterLink
      >
      <div class="auth-intro">
        <h1>Your signature.<br />Ready when you are.</h1>
        <p>
          Draw it once, or upload your PNG. Keep your signatures close and get
          your PDFs signed.
        </p>
        <ul class="auth-benefits">
          <li><Check :size="19" />Your own private signature library</li>
          <li><Check :size="19" />PDFs signed in a few simple steps</li>
          <li><Check :size="19" />Signing links for other people</li>
        </ul>
      </div>
      <p class="auth-foot">A little less paperwork.</p>
    </div>
    <div class="auth-form-area">
      <div class="auth-form">
        <h2>{{ title }}</h2>
        <p class="muted">{{ description }}</p>
        <form @submit.prevent="submit">
          <template v-if="secondFactor">
            <label class="field"
              >{{ recovery ? "Recovery code" : "Authenticator code" }}
              <input
                v-model="code"
                :inputmode="recovery ? 'text' : 'numeric'"
                autocomplete="one-time-code"
                :pattern="recovery ? undefined : '[0-9]{6}'"
                :maxlength="recovery ? 32 : 6"
                required
                autofocus
              />
            </label>
            <label v-if="!recovery" class="remember-browser"
              ><input v-model="rememberBrowser" type="checkbox" /><span
                >Remember this browser for 7 days</span
              ></label
            >
            <button
              class="text-button"
              type="button"
              @click="
                recovery = !recovery;
                code = '';
                error = '';
              "
            >
              {{ recovery ? "Use my authenticator" : "Use a recovery code" }}
            </button>
          </template>
          <template v-else>
            <label v-if="register" class="field"
              >Your name<input
                v-model="name"
                autocomplete="name"
                required
                maxlength="100"
                autofocus
            /></label>
            <label v-if="!reset" class="field"
              >Email address<input
                v-model="email"
                type="email"
                autocomplete="email"
                required
                maxlength="254"
                :autofocus="!register"
            /></label>
            <label v-if="!forgot" class="field"
              ><span id="password-label">{{
                reset ? "New password" : "Password"
              }}</span>
              <input
                aria-labelledby="password-label"
                :aria-describedby="
                  register || reset ? 'password-hint' : undefined
                "
                v-model="password"
                type="password"
                :autocomplete="
                  register || reset ? 'new-password' : 'current-password'
                "
                required
                :minlength="register || reset ? 12 : undefined"
                maxlength="128"
              />
              <span v-if="register || reset" id="password-hint" class="hint"
                >Use at least 12 characters.</span
              >
            </label>
            <label v-if="reset" class="field"
              >Confirm new password<input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                required
                minlength="12"
                maxlength="128"
            /></label>
          </template>
          <p v-if="error" class="notice error" role="alert">{{ error }}</p>
          <p v-if="notice" class="notice" role="status">{{ notice }}</p>
          <p v-if="register && !registrationEnabled" class="notice">
            Registration is currently closed.
          </p>
          <p v-if="forgot && !emailEnabled" class="notice">
            Password recovery needs email delivery. Contact the administrator to
            configure it.
          </p>
          <button
            class="button primary auth-submit"
            :disabled="
              busy ||
              (register && !registrationEnabled) ||
              (forgot && !emailEnabled) ||
              (reset && !resetToken)
            "
          >
            {{
              busy
                ? "Please wait…"
                : secondFactor
                  ? "Verify and sign in"
                  : reset
                    ? "Save new password"
                    : forgot
                      ? "Send reset link"
                      : register
                        ? "Create account"
                        : "Sign in"
            }}<ArrowRight :size="18" />
          </button>
        </form>
        <p v-if="secondFactor" class="auth-switch">
          <button
            class="text-button"
            @click="
              secondFactor = false;
              code = '';
              error = '';
            "
          >
            Back to sign in
          </button>
        </p>
        <p v-else-if="forgot || reset" class="auth-switch">
          <RouterLink to="/login">Back to sign in</RouterLink
          ><template v-if="reset">
            ·
            <RouterLink to="/forgot-password"
              >Request a new reset link</RouterLink
            ></template
          >
        </p>
        <template v-else>
          <p v-if="!register" class="auth-switch">
            <RouterLink to="/forgot-password">Forgot your password?</RouterLink>
          </p>
          <p class="auth-switch">
            <template v-if="register"
              >Already have an account?
              <RouterLink :to="{ path: '/login', query: route.query }"
                >Sign in</RouterLink
              ></template
            ><template v-else-if="registrationEnabled"
              >New here?
              <RouterLink :to="{ path: '/register', query: route.query }"
                >Create an account</RouterLink
              ></template
            >
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
