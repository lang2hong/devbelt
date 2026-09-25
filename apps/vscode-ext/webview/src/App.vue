<script setup lang="ts">
import { ref, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { useVsCode } from './composables/useVsCode';
import { setLanguage } from './composables/useI18n';
import type { WebviewMode, HubTab } from '../../src/result/protocol';
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
import AccountHubView from './views/AccountHubView.vue';

// 验证器视图按需加载：单独分片，不把体积压到所有 panel 共用的 index.js 主 bundle。
const AuthenticatorView = defineAsyncComponent(() => import('./views/AuthenticatorView.vue'));
// Redis 面板（P7 S2）同样按需加载，单独分片。
const RedisView = defineAsyncComponent(() => import('./views/RedisView.vue'));

const { onMessage } = useVsCode();
const mode = ref<WebviewMode>('query');
const hubTab = ref<HubTab>('account');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      // 语言在切换视图之前设置：各视图挂载时就能取到正确文案。
      // isZh 由 BaseWebView.post 统一注入，webview 自身拿不到 vscode 配置。
      setLanguage(!!msg.isZh);
      if (msg.mode === 'accountHub' && msg.tab) hubTab.value = msg.tab as HubTab;
      mode.value = (msg.mode as WebviewMode) || 'query';
    } else if (msg.type === 'selectTab' && msg.tab) {
      // 面板已打开时，命令切换标签。
      hubTab.value = msg.tab as HubTab;
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
      <AccountHubView v-else-if="mode === 'accountHub'" :tab="hubTab" />
      <AuthenticatorView v-else-if="mode === 'authenticator'" />
      <RedisView v-else-if="mode === 'redis'" />
      <ERDiagramView v-else />
</template>
