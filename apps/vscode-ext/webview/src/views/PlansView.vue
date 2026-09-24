<script setup lang="ts">
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { featureLabel, formatFeature, formatPrice, type PlanCatalog, type PlanDto } from '../utils/planFeatures';

/**
 * 套餐面板：展示个人套餐目录与当前个人套餐，升级跳浏览器控制台。
 * 消息协议（与 src/sync/plansView.ts 对齐）：
 *   webview → ext: ready | openConsole{path}
 *   ext → webview: plans{plans,current,loggedIn} | error{message}
 */
const { post, onMessage } = useVsCode();
let __offMsg: (() => void) | undefined;
const { t } = useI18n();

const state = ref<'loading' | 'ready' | 'error' | 'loginRequired'>('loading');
const catalog = ref<PlanCatalog | null>(null);
const current = ref<string>('free');

const personal = computed<PlanDto[]>(() => catalog.value?.personal ?? []);

function isCurrent(plan: PlanDto): boolean {
  return plan.code === (current.value || 'free');
}

function canUpgrade(plan: PlanDto): boolean {
  return plan.code === 'pro' && current.value !== 'pro';
}

function openConsole(path: string): void {
  post({ type: 'openConsole', path });
}

onMounted(() => {
  post({ type: 'ready', view: 'plans' });
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'plans') {
      if (!msg.loggedIn) {
        state.value = 'loginRequired';
        return;
      }
      catalog.value = msg.plans;
      current.value = msg.current ?? 'free';
      state.value = 'ready';
    } else if (msg.type === 'error') {
      state.value = 'error';
    }
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="plans-panel">
    <h2>{{ t('plan.title') }}</h2>
    <p class="muted">{{ t('plan.intro') }}</p>

    <p v-if="state === 'loading'" class="muted">…</p>
    <p v-else-if="state === 'error'" class="err">{{ t('plan.loadFailed') }}</p>
    <p v-else-if="state === 'loginRequired'" class="muted">{{ t('plan.loginRequired') }}</p>

    <template v-else>
      <h3 class="section">{{ t('plan.section.personal') }}</h3>
      <div class="grid">
        <div v-for="plan in personal" :key="plan.code" class="card" :class="{ current: isCurrent(plan) }">
          <div class="head">
            <span class="name">{{ plan.name }}</span>
            <span v-if="isCurrent(plan)" class="badge">{{ t('plan.current') }}</span>
          </div>
          <p class="price">{{ formatPrice(plan.billing) }}</p>
          <ul class="features">
            <li v-for="f in plan.features" :key="f.key">
              <span class="label">{{ featureLabel(f.key, f.label) }}</span>
              <span class="value">{{ formatFeature(f) }}</span>
            </li>
          </ul>
          <button v-if="canUpgrade(plan)" class="btn" @click="openConsole('/db/checkout')">{{ t('plan.upgrade', { name: plan.name }) }}</button>
          <p v-else-if="isCurrent(plan)" class="ok">{{ t('plan.inUse') }}</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plans-panel { padding: 16px; }
h2 { font-size: 18px; font-weight: 700; color: var(--vscode-foreground); margin: 0 0 4px; }
.section { font-size: 14px; font-weight: 600; color: var(--vscode-foreground); margin: 20px 0 10px; }
.intro { margin: 0 0 8px; }
.note { margin: 0 0 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; padding: 14px 16px; }
.card.current { border-color: var(--vscode-focusBorder); }
.head { display: flex; align-items: center; justify-content: space-between; }
.name { font-size: 15px; font-weight: 700; }
.badge { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 11px; padding: 1px 7px; border-radius: 9px; }
.price { font-size: 13px; font-weight: 600; margin: 6px 0 10px; }
.features { list-style: none; padding: 0; margin: 0; }
.features li { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-top: 1px solid var(--vscode-panel-border, #333); font-size: 12px; }
.features li:first-child { border-top: none; }
.label { opacity: 0.8; }
.value { text-align: right; }
.btn { margin-top: 12px; width: 100%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 7px 14px; border-radius: 4px; font-size: 13px; cursor: pointer; }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.ok { margin-top: 10px; color: var(--vscode-charts-green, #3fb950); font-size: 12px; }
.err { color: var(--vscode-errorForeground); }
.muted { opacity: 0.75; font-size: 12px; }
</style>