<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { formatCreditTokens, isQuotaLow } from '../../utils/credits';
import type { QuotaState } from './ContextBar.vue';

/**
 * 额度明细（「⋯ → 额度」抽屉）：低额度时顶栏才常驻提示，其余时候在这里查。
 * 自带 Key 模式不走服务端积分，只给一句说明。
 */
const props = defineProps<{
  quota: QuotaState | null;
  byok: boolean;
  refreshing?: boolean;
  feedback?: 'ok' | 'failed' | null;
}>();
const emit = defineEmits<{ refresh: []; buy: [] }>();
const { t } = useI18n();

const low = computed(() => isQuotaLow(props.quota));
const usedPct = computed(() => {
  const q = props.quota;
  if (!q) return 0;
  const total = q.used + q.remaining;
  return total > 0 ? Math.min(100, Math.max(0, (q.used / total) * 100)) : 0;
});
</script>

<template>
  <div class="ai-quota-panel">
    <p v-if="props.byok" class="ai-quota-note">{{ t('wv.ai.quota.byok') }}</p>
    <p v-else-if="!props.quota" class="ai-quota-note">{{ t('wv.ai.quota.none') }}</p>
    <template v-else>
      <dl class="ai-quota-list">
        <dt>{{ t('wv.ai.quota.remainingLabel') }}</dt>
        <dd :class="{ low }">{{ formatCreditTokens(props.quota.remaining) }}</dd>
        <dt>{{ t('wv.ai.quota.usedLabel') }}</dt>
        <dd>{{ formatCreditTokens(props.quota.used) }} / {{ formatCreditTokens(props.quota.limit) }}</dd>
        <template v-if="props.quota.topupRemaining > 0">
          <dt>{{ t('wv.ai.quota.monthlyLabel') }}</dt>
          <dd>{{ formatCreditTokens(props.quota.monthlyRemaining ?? props.quota.remaining) }}</dd>
          <dt>{{ t('wv.ai.quota.topupLabel') }}</dt>
          <dd>{{ formatCreditTokens(props.quota.topupRemaining) }}</dd>
        </template>
      </dl>
      <div class="ai-quota-bar" :class="{ low }" :title="t('wv.ai.quota.barTitle')"><span :style="{ width: `${usedPct}%` }"></span></div>
    </template>
    <div v-if="!props.byok" class="ai-quota-actions">
      <button class="ai-btn" :disabled="props.refreshing" @click="emit('refresh')">
        {{ props.refreshing ? t('wv.ai.quota.refreshing') : t('wv.ai.quota.refresh') }}
      </button>
      <button v-if="props.quota" class="ai-btn ai-btn-primary" :title="t('wv.ai.quota.buy.title')" @click="emit('buy')">{{ t('wv.ai.quota.buy') }}</button>
      <span v-if="props.feedback" class="ai-quota-feedback" :class="props.feedback" role="status" aria-live="polite">
        {{ props.feedback === 'ok' ? t('wv.ai.quota.refreshOk') : t('wv.ai.quota.refreshFailed') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.ai-quota-note { margin: 0; color: var(--vscode-descriptionForeground); }
.ai-quota-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0 0 10px; }
.ai-quota-list dt { color: var(--vscode-descriptionForeground); }
.ai-quota-list dd { margin: 0; font-variant-numeric: tabular-nums; }
.ai-quota-list dd.low { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 600; }
.ai-quota-bar { height: 4px; border-radius: 2px; background: var(--vscode-panel-border); overflow: hidden; margin-bottom: 12px; }
.ai-quota-bar span { display: block; height: 100%; background: var(--vscode-progressBar-background, #0e70c0); }
.ai-quota-bar.low span { background: var(--vscode-editorWarning-foreground, #cca700); }
.ai-quota-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ai-quota-feedback.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.ai-quota-feedback.failed { color: var(--vscode-errorForeground, #f85149); }
</style>
