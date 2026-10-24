<script setup lang="ts" generic="E extends keyof AdminRows">
// A searchable, paged Admin list. Results that arrive after the location has
// changed, or after the section has closed, are discarded.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { Search } from "@lucide/vue";
import { api, errorMessage } from "../../api";
import type { PageResult } from "../../../shared/admin-types";
import {
  locationQuery,
  PAGE_SIZE,
  useAdminContext,
  type AdminRows,
} from "./context";

type Row = AdminRows[E];
const props = defineProps<{ title: string; label: string; endpoint: E }>();
const emit = defineEmits<{ loaded: [items: Row[]] }>();
defineSlots<{
  default(props: { items: Row[] }): unknown;
  filters?(): unknown;
}>();
const { location, busy, registerList, navigate, refresh, checkAccess } =
  useAdminContext();
const router = useRouter();
const state = ref<"loading" | "loaded" | "error">("loading");
const failure = ref("");
const items = shallowRef<Row[]>([]);
const total = ref(0);
const search = ref(location.value.query);
const loading = computed(() => state.value === "loading");
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
let requestId = 0;
let disposed = false;

async function load() {
  const id = ++requestId;
  const selected = location.value;
  state.value = "loading";
  failure.value = "";
  total.value = 0;
  items.value = [];
  const params = new URLSearchParams({
    page: String(selected.page),
    pageSize: String(PAGE_SIZE),
    search: selected.query,
  });
  if (selected.ownerId) params.set("userId", selected.ownerId);
  try {
    const result = await api<PageResult<Row>>(
      `/admin/${props.endpoint}?${params}`,
    );
    if (id !== requestId || disposed) return;
    const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    if (selected.page > lastPage) {
      await router.replace({
        path: "/admin",
        query: locationQuery({ ...selected, page: lastPage }),
      });
      return;
    }
    total.value = result.total;
    items.value = result.items;
    emit("loaded", result.items);
    state.value = "loaded";
  } catch (e) {
    if (id !== requestId || disposed) return;
    failure.value = errorMessage(e);
    state.value = "error";
    await checkAccess(e, () => id === requestId && !disposed);
  }
}
defineExpose({ reload: load });
const unregister = registerList(load);
watch(
  () => JSON.stringify(location.value),
  () => {
    search.value = location.value.query;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  ++requestId;
  unregister();
});

async function find() {
  if (busy.value || loading.value) return;
  await navigate({
    ...location.value,
    query: search.value.trim().slice(0, 100),
    page: 1,
  });
}
async function paginate(delta: number) {
  if (busy.value || loading.value) return;
  await navigate({
    ...location.value,
    page: Math.min(pages.value, Math.max(1, location.value.page + delta)),
  });
}
</script>

<template>
  <div class="admin-list-toolbar">
    <h2>
      {{ title }}
      <span v-if="state === 'loaded'" class="admin-list-count">{{
        total
      }}</span>
    </h2>
    <div class="admin-list-tools">
      <form class="admin-search" @submit.prevent="find">
        <label class="search"
          ><Search :size="17" /><span class="sr-only">Search {{ label }}</span
          ><input
            v-model="search"
            :placeholder="`Find ${label}`"
            maxlength="100"
        /></label>
        <button class="button secondary" :disabled="loading || busy">
          Search
        </button>
      </form>
      <button class="text-button" :disabled="loading || busy" @click="refresh">
        Refresh
      </button>
    </div>
  </div>
  <slot name="filters" />
  <p v-if="loading" class="loading" role="status">Loading {{ label }}…</p>
  <div v-else-if="state === 'error'" class="admin-load-error">
    <p role="alert">Could not load {{ label }}. {{ failure }}</p>
    <button class="button secondary" :disabled="busy" @click="load">
      Retry
    </button>
  </div>
  <p v-else-if="!total" class="admin-empty">
    {{
      location.query
        ? `No ${label} match “${location.query}”.`
        : `No ${label} yet.`
    }}
  </p>
  <div v-else class="admin-records" :aria-label="title">
    <slot :items="items" />
  </div>
  <div v-if="state === 'loaded' && total > 0" class="admin-pagination">
    <span
      >{{ total }} {{ label }} · Page {{ location.page }} of {{ pages }}</span
    >
    <div class="button-row">
      <button
        class="button secondary"
        :disabled="location.page <= 1 || loading || busy"
        @click="paginate(-1)"
      >
        Previous</button
      ><button
        class="button secondary"
        :disabled="location.page >= pages || loading || busy"
        @click="paginate(1)"
      >
        Next
      </button>
    </div>
  </div>
</template>

<style scoped>
.admin-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}
.admin-list-toolbar h2 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 20px;
}
.admin-list-count {
  color: var(--muted);
  font-size: 14px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.admin-list-tools {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}
.admin-search {
  display: flex;
  align-items: stretch;
  min-width: 0;
}
.admin-search .search {
  min-width: 0;
  width: 260px;
}
.admin-search .search input {
  min-width: 0;
  width: 100%;
  border-radius: 7px 0 0 7px;
}
.admin-search > button {
  flex-shrink: 0;
  border-radius: 0 7px 7px 0;
  margin-left: -1px;
}
.admin-list-tools > button {
  flex-shrink: 0;
}
.admin-load-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 20px 0;
}
.admin-load-error p {
  color: var(--red);
  overflow-wrap: anywhere;
  flex: 1 1 240px;
}
.admin-records {
  border-top: 1px solid var(--line);
}
.admin-empty {
  padding: 32px 0;
  color: var(--muted);
}
.admin-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 20px;
  font-size: 13px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1200px) {
  .admin-list-toolbar {
    flex-wrap: wrap;
  }
  .admin-list-tools {
    flex: 1 1 380px;
    justify-content: flex-end;
  }
  .admin-search {
    flex: 1;
    max-width: 390px;
  }
  .admin-search .search {
    width: auto;
    flex: 1;
  }
}
@media (max-width: 680px) {
  .admin-list-toolbar {
    gap: 14px;
    margin-bottom: 18px;
  }
  .admin-list-tools {
    flex: 1 1 100%;
    gap: 12px;
  }
  .admin-search {
    max-width: none;
  }
  .admin-search > button {
    padding-inline: 10px;
  }
  .admin-pagination {
    flex-wrap: wrap;
  }
  .admin-pagination .button-row {
    margin-left: auto;
  }
}
@media (max-width: 380px) {
  .admin-list-tools {
    flex-wrap: wrap;
  }
  .admin-search {
    flex-basis: 100%;
  }
  .admin-list-tools > button {
    margin-left: auto;
  }
}
</style>
