<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from './composables/useVsCode';
import { setLanguage } from './composables/useI18n';
import QueryView from './views/QueryView.vue';
import DesignView from './views/DesignView.vue';
import StatusView from './views/StatusView.vue';
import ERDiagramView from './views/ERDiagramView.vue';
import ConnectionFormView from './views/ConnectionFormView.vue';
import UserManageView from './views/UserManageView.vue';
import DataDiffView from './views/DataDiffView.vue';
import DashboardView from './views/DashboardView.vue';
import AuditLogView from './views/AuditLogView.vue';
import PoolStatusView from './views/PoolStatusView.vue';
import LoginFormView from './views/LoginFormView.vue';
import SessionView from './views/SessionView.vue';
import AccountView from './views/AccountView.vue';
import PlansView from './views/PlansView.vue';

const { onMessage } = useVsCode();
const mode = ref<'query' | 'design' | 'status' | 'er' | 'connectionForm' | 'userManage' | 'dataDiff' | 'dashboard' | 'auditLog' | 'poolStatus' | 'loginForm' | 'session' | 'account' | 'plans'>('query');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      // 语言在切换视图之前设置：各视图挂载时就能取到正确文案。
      // isZh 由 BaseWebView.post 统一注入，webview 自身拿不到 vscode 配置。
      setLanguage(!!msg.isZh);
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
  <UserManageView v-else-if="mode === 'userManage'" />
  <DataDiffView v-else-if="mode === 'dataDiff'" />
  <DashboardView v-else-if="mode === 'dashboard'" />
<AuditLogView v-else-if="mode === 'auditLog'" />
      <PoolStatusView v-else-if="mode === 'poolStatus'" />
      <LoginFormView v-else-if="mode === 'loginForm'" />
      <SessionView v-else-if="mode === 'session'" />
      <AccountView v-else-if="mode === 'account'" />
      <PlansView v-else-if="mode === 'plans'" />
      <ERDiagramView v-else />
</template>
