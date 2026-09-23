<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listPlans } from '../api/plans';
import { setAccessToken } from '@devbelt/auth-client';
import { navigate, withBase } from '../lib/router';
import { featureLabel, formatFeature, formatPrice, type PlanDto } from '../lib/planFeatures';

/** 个人订阅快照（与 AccountView / CheckoutView 同口径）。 */
interface Subscription {
  planCode: string | null;
  status: string;
  periodEndTime: string | null;
}

const props = defineProps<{ subscription: Subscription | null }>();

const state = ref<'loading' | 'ready' | 'error'>('loading');
const personal = ref<PlanDto[]>([]);

/** 免费档为默认权益；无订阅时视为 free。 */
const currentCode = computed<string>(() => props.subscription?.planCode ?? 'free');

onMounted(async () => {
  const r = await listPlans();
  if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign('/login');
    return;
  }
  if (r.kind === 'failure') {
    state.value = 'error';
    return;
  }
  personal.value = r.value.personal;
  state.value = 'ready';
});

function isCurrent(plan: PlanDto): boolean {
  return plan.code === currentCode.value;
}

function canUpgrade(plan: PlanDto): boolean {
  return plan.code === 'pro' && currentCode.value !== 'pro';
}
</script>

<template>
  <section class="page">
    <h2>套餐</h2>
    <p class="intro muted">查看各套餐包含的功能，以及你当前所处的套餐。</p>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">套餐加载失败，请稍后重试。</p>

    <template v-else>
      <h3 class="section">个人套餐</h3>
      <div class="grid">
        <div v-for="plan in personal" :key="plan.code" class="card" :class="{ current: isCurrent(plan) }">
          <div class="head">
            <span class="name">{{ plan.name }}</span>
            <span v-if="isCurrent(plan)" class="badge">当前套餐</span>
          </div>
          <p class="price">{{ formatPrice(plan.billing) }}</p>
          <ul class="features">
            <li v-for="f in plan.features" :key="f.key">
              <span class="label">{{ featureLabel(f.key, f.label) }}</span>
              <span class="value">{{ formatFeature(f) }}</span>
            </li>
          </ul>
          <button v-if="canUpgrade(plan)" class="btn" @click="navigate('/checkout')">升级 {{ plan.name }}</button>
          <p v-else-if="isCurrent(plan)" class="ok">已在使用</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 760px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.section { font-size: 15px; font-weight: 600; color: var(--c-text); margin: 24px 0 12px; }
.intro { margin: 6px 0 8px; }
.note { margin: 0 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.card { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 18px 20px; }
.card.current { border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent) inset; }
.head { display: flex; align-items: center; justify-content: space-between; }
.name { font-size: 16px; font-weight: 700; color: var(--c-text); }
.badge { background: var(--c-accent); color: var(--c-surface); font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.price { font-size: 14px; font-weight: 600; color: var(--c-text); margin: 8px 0 12px; }
.features { list-style: none; padding: 0; margin: 0; }
.features li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px dashed #eaeef2; font-size: 13px; }
.features li:first-child { border-top: none; }
.label { color: var(--c-text-muted); }
.value { color: var(--c-text); text-align: right; }
.btn { margin-top: 16px; width: 100%; background: var(--c-accent); color: var(--c-surface); border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.ok { margin-top: 14px; color: var(--c-success-text); font-size: 13px; }
.error { color: var(--c-danger); }
.muted { color: var(--c-text-muted); font-size: 13px; }
</style>