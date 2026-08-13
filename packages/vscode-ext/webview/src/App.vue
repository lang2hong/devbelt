<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from './composables/useVsCode';
import QueryView from './views/QueryView.vue';
import DesignView from './views/DesignView.vue';
import StatusView from './views/StatusView.vue';
import ERDiagramView from './views/ERDiagramView.vue';
import ConnectionFormView from './views/ConnectionFormView.vue';
import UserFormView from './views/UserFormView.vue';
import SyncDiffView from './views/SyncDiffView.vue';
import DataDiffView from './views/DataDiffView.vue';
import DashboardView from './views/DashboardView.vue';

const { onMessage } = useVsCode();
const mode = ref<'query' | 'design' | 'status' | 'er' | 'connectionForm' | 'userForm' | 'syncDiff' | 'dataDiff' | 'dashboard'>('query');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      mode.value = msg.mode || 'query';
    }
  });
});
onUnmounted(() => cleanup?.());
</script>

<template>
  <QueryView v-if="mode === 'query'" />
  <DesignView v-else-if="mode === 'design'" />
  <StatusView v-else-if="mode === 'status'" />
  <ConnectionFormView v-else-if="mode === 'connectionForm'" />
  <UserFormView v-else-if="mode === 'userForm'" />
  <SyncDiffView v-else-if="mode === 'syncDiff'" />
  <DataDiffView v-else-if="mode === 'dataDiff'" />
  <DashboardView v-else-if="mode === 'dashboard'" />
  <ERDiagramView v-else />
</template>
