<script setup lang="ts">
import { ref } from 'vue';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { updateDisplayName, changePassword, type ConsoleMeUser } from '../api/me';
import { getAiUsage, type AiUsageSnapshot } from '../api/ai';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { navigate, withBase } from '../lib/router';
import { formatDateTime } from '../lib/formatTime';

const props = defineProps<{ user: ConsoleMeUser | null; subscription: { planCode: string | null; status: string; periodEndTime: string | null } | null }>();

const displayName = ref(props.user?.displayName ?? '');
const nameSaving = ref(false);
const nameError = ref('');
const nameSaved = ref(false);

const current = ref('');
const next = ref('');
const confirm = ref('');
const pwError = ref('');
const pwSubmitting = ref(false);
const showPassword = ref(false);

const nameWrite = useIdempotencyKey();

// AI 双段积分（月度赠送 + 充值）。
const aiUsage = ref<AiUsageSnapshot | null>(null);
const aiUsageState = ref<'loading' | 'ready' | 'error'>('loading');

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString();
}

async function loadAiUsage(): Promise<void> {
  aiUsageState.value = 'loading';
  const r = await getAiUsage();
  if (r.kind === 'ok') {
    aiUsage.value = r.value;
    aiUsageState.value = 'ready';
  } else {
    aiUsageState.value = 'error';
    aiUsage.value = null;
  }
}

void loadAiUsage();

function forceRelogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function saveName(): Promise<void> {
  if (!props.user || nameSaving.value) return;
  nameSaving.value = true;
  nameError.value = '';
  nameSaved.value = false;
  try {
    const value = displayName.value.trim();
    const tag = `displayName:${value}`;
    const csrf = await ensureCsrf();
    const r = await updateDisplayName(value, nameWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      nameWrite.reset(tag);
      nameSaved.value = true;
    } else if (r.kind === 'unauthorized') {
      nameWrite.reset(tag);
      forceRelogin();
    } else if (isRetryableFailure(r.kind)) {
      nameError.value = '保存失败，请重试。';
    } else {
      nameWrite.reset(tag);
      nameError.value = '保存失败，请重试。';
    }
  } finally {
    nameSaving.value = false;
  }
}

async function submitPassword(): Promise<void> {
  if (pwSubmitting.value) return;
  pwError.value = '';
  if (next.value !== confirm.value) {
    pwError.value = '两次输入的新密码不一致。';
    return;
  }
  pwSubmitting.value = true;
  try {
    const csrf = await ensureCsrf();
    const r = await changePassword(current.value, next.value, csrf);
    if (r.kind === 'ok') forceRelogin();
    else if (r.kind === 'invalid-current-password') pwError.value = '当前密码错误。';
    else pwError.value = '改密失败，请重试。';
  } finally {
    pwSubmitting.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>账户</h2>
      <p class="sub">管理你的登录信息与订阅。</p>
    </header>

    <div class="cards">
    <div class="card">
      <h3>基本信息</h3>
      <div class="kv"><span class="k">邮箱</span><span class="v">{{ user?.email ?? '' }}</span></div>
      <div class="kv" v-if="user">
        <span class="k">验证状态</span>
        <span class="v"><span class="badge" :class="user.emailVerified ? 'ok' : 'warn'">{{ user.emailVerified ? '已验证' : '未验证' }}</span></span>
      </div>
      <div class="field">
        <label>显示名</label>
        <input v-model="displayName" type="text" maxlength="100" />
      </div>
      <p v-if="nameError" class="error">{{ nameError }}</p>
      <p v-if="nameSaved" class="ok">已保存。</p>
      <div class="actions"><button class="btn" :disabled="nameSaving" @click="saveName">{{ nameSaving ? '保存中…' : '保存' }}</button></div>
    </div>

    <div class="card">
      <h3>订阅</h3>
      <template v-if="subscription">
        <div class="kv"><span class="k">当前套餐</span><span class="v"><strong>{{ subscription.planCode === 'pro' ? 'Pro' : (subscription.planCode ?? '—') }}</strong> <span class="badge" :class="subscription.status === 'active' ? 'ok' : ''">{{ subscription.status === 'active' ? '生效中' : subscription.status }}</span></span></div>
        <div class="kv" v-if="subscription.periodEndTime"><span class="k">到期时间</span><span class="v">{{ formatDateTime(subscription.periodEndTime) }}</span></div>
      </template>
      <p class="muted" v-else>暂无订阅。</p>
      <div class="actions" v-if="subscription?.planCode !== 'pro'"><button class="btn accent" @click="navigate('/checkout')">升级 Pro</button></div>
    </div>

    <div class="card">
      <h3>AI 配额</h3>
      <template v-if="aiUsageState === 'ready' && aiUsage">
        <div class="kv"><span class="k">本月赠送剩余</span><span class="v"><strong>{{ fmtCredits(aiUsage.monthlyRemaining) }}</strong> 积分<span class="muted small">（{{ formatDateTime(aiUsage.resetAt) }} 重置）</span></span></div>
        <div class="kv"><span class="k">充值余额</span><span class="v"><strong>{{ fmtCredits(aiUsage.topupRemaining) }}</strong> 积分</span></div>
        <div class="kv"><span class="k">本月已用</span><span class="v">{{ fmtCredits(aiUsage.used) }} / {{ fmtCredits(aiUsage.limit) }} 积分</span></div>
        <p class="muted small">1 积分 = 1000 计费 token（输出按折算倍数加权）；本月赠送优先扣，不足部分按到期先后扣充值积分。</p>
      </template>
      <p class="muted" v-else-if="aiUsageState === 'loading'">加载中…</p>
      <p class="muted" v-else>配额加载失败。<button class="link" @click="loadAiUsage">重试</button></p>
      <div class="actions"><button class="btn accent" @click="navigate('/ai-topup')">充值积分</button></div>
    </div>

    </div>

    <div class="card">
      <h3>修改密码</h3>
      <div class="field"><label>当前密码</label><input v-model="current" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required /></div>
      <div class="field">
        <label>新密码（9–128 字符）</label>
        <div class="pw">
          <input v-model="next" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" required />
          <button type="button" class="toggle" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">{{ showPassword ? '🙈' : '' }}</button>
        </div>
      </div>
      <div class="field"><label>确认新密码</label><input v-model="confirm" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" required /></div>
      <p v-if="pwError" class="error">{{ pwError }}</p>
      <p class="muted small">修改密码后将退出全部设备，需重新登录。</p>
      <div class="actions"><button class="btn danger" :disabled="pwSubmitting" @click="submitPassword">{{ pwSubmitting ? '提交中…' : '修改密码' }}</button></div>
    </div>
  </section>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 720px) { .cards { grid-template-columns: 1fr; } }
.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 20px 22px; margin-bottom: 16px; }
.cards .card { margin-bottom: 0; }
h3 { font-size: 14px; font-weight: 600; margin: 0 0 14px; }
.kv { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: center; padding: 6px 0; }
.kv .k { color: var(--c-text-muted); font-size: 13px; }
.kv .v { font-size: 13.5px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; }
label { font-size: 12px; color: var(--c-text-muted); }
input { width: 100%; box-sizing: border-box; }
.pw { position: relative; }
.pw input { padding-right: 38px; }
.toggle { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); border: none; background: none; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px; opacity: .55; }
.toggle:hover { opacity: 1; }
.btn.accent { background: var(--c-accent); }
.badge { display: inline-flex; padding: 1px 8px; border-radius: var(--r-pill); font-size: 12px; background: #eaeef2; color: var(--c-text-muted); }
.badge.ok { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.warn { background: var(--c-warn-bg); color: var(--c-warn-text); }
.ok { color: var(--c-success-text); font-size: 13px; }
.small { font-size: 12px; }
.link { border: none; background: none; color: var(--c-accent); cursor: pointer; font-size: 13px; padding: 0; }
</style>
