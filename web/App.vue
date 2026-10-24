<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  FileText,
  PenLine,
  LogOut,
  Feather,
  Shield,
  Settings,
  Archive,
} from "@lucide/vue";
import { api, currentUser } from "./api";
const route = useRoute(),
  router = useRouter();
const workspace = computed(() => !route.meta.public);
async function logout() {
  await api("/auth/sign-out", { method: "POST", body: "{}" });
  currentUser.value = null;
  await router.push("/login");
}
</script>
<template>
  <a class="skip-link" href="#main">Skip to content</a>
  <div v-if="workspace" class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/documents" aria-label="PaperSign home"
        ><Feather :size="27" /><span
          >PaperSign<span class="brand-dot">.</span></span
        ></RouterLink
      >
      <nav aria-label="Main navigation">
        <RouterLink
          to="/documents"
          :class="{ active: route.path.startsWith('/documents') }"
          ><FileText :size="20" />Documents</RouterLink
        ><RouterLink to="/signatures" active-class="active"
          ><PenLine :size="20" />My signatures</RouterLink
        >
        <RouterLink to="/account" active-class="active"
          ><Settings :size="20" />Account security</RouterLink
        >
        <RouterLink to="/privacy" active-class="active"
          ><Archive :size="20" />Your data</RouterLink
        >
        <RouterLink
          v-if="currentUser?.role === 'admin'"
          to="/admin"
          active-class="active"
          ><Shield :size="20" />Admin</RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="avatar">
          {{ currentUser?.name.slice(0, 1).toUpperCase() }}
        </div>
        <div
          class="account-name"
          :title="currentUser?.email"
          :aria-label="`Signed in as ${currentUser?.name}, ${currentUser?.email}`"
        >
          <strong>{{ currentUser?.name }}</strong
          ><span>{{ currentUser?.email }}</span>
        </div>
        <button
          class="icon-button signout"
          aria-label="Sign out"
          title="Sign out"
          @click="logout"
        >
          <LogOut :size="18" />
        </button>
      </div>
    </aside>
    <main id="main" class="workspace"><RouterView :key="route.path" /></main>
  </div>
  <main v-else id="main"><RouterView :key="route.path" /></main>
</template>
