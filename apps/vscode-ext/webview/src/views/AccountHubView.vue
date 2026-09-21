<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import type { HubTab } from '../../../src/result/protocol';
import AccountView from './AccountView.vue';
import SessionView from './SessionView.vue';
import PlansView from './PlansView.vue';

/**
 * 账户中心容器：单面板 + 标签页（账户 / 设备 / 套餐）。
 * 仅渲染激活标签的子视图（v-if），使子视图挂载时发 `ready{view}` 拉取各自数据。
 * 标签由根 App.vue 通过 `tab` prop 驱动（init.tab / selectTab 消息）。
 */
const props = defineProps<{ tab?: HubTab }>();
const { t } = useI18n();

const active = ref<HubTab>(props.tab ?? 'account');
watch(() => props.tab, (v) => { if (v) active.value = v; });
</script>

<template>
  <div class="hub">
    <nav class="hub-tabs">
      <button
        v-for="tb in ([
          { id: 'account', label: t('account.title') },
          { id: 'session', label: t('sessions.title') },
          { id: 'plans', label: t('plan.title') },
        ] as { id: HubTab; label: string }[])"
        :key="tb.id"
        class="hub-tab"
        :class="{ on: active === tb.id }"
        @click="active = tb.id"
      >{{ tb.label }}</button>
    </nav>
    <div class="hub-body">
      <AccountView v-if="active === 'account'" />
      <SessionView v-else-if="active === 'session'" />
      <PlansView v-else-if="active === 'plans'" />
    </div>
  </div>
</template>

<style scoped>
.hub { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.hub-tabs {
  display: flex; gap: 4px; padding: 8px 12px 0;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  background: var(--vscode-editor-background);
}
.hub-tab {
  background: transparent; border: none; cursor: pointer;
  padding: 7px 14px; font-size: 13px; color: var(--vscode-descriptionForeground);
  border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0;
}
.hub-tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12)); }
.hub-tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #007acc); font-weight: 600; }
.hub-body { flex: 1; min-height: 0; overflow: auto; }
</style>