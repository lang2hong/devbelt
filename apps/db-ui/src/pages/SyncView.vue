<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { syncOverview, type SyncOverview } from '../api/sync';
import { setAccessToken } from '@devkit/auth-client';
import { formatDateTime } from '../lib/formatTime';

const overview = ref<SyncOverview | null>(null);
const state = ref<'loading' | 'ready' | 'error'>('loading');

function formatBytes(n: number | null): string {
  if (n === null) return '不限';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

onMounted(async () => {
  const r = await syncOverview();
  if (r.kind === 'ok') {
    overview.value = r.value;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign(withBase('/login'));
  } else {
    state.value = 'error';
  }
});
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>同步</h2>
      <p class="sub">个人同步状态与操作。</p>
    </header>
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <div v-if="state === 'ready' && overview" class="card">
      <p v-if="!overview.initialized" class="muted">尚未初始化同步。</p>
      <dl v-else class="grid">
        <div><dt>活跃记录</dt><dd>{{ overview.activeRecordCount }}</dd></div>
        <div><dt>密文体积</dt><dd>{{ formatBytes(overview.ciphertextBytes) }}</dd></div>
        <div><dt>记录配额</dt><dd>{{ overview.recordLimit ? overview.recordLimit : '不限' }}</dd></div>
        <div><dt>存储配额</dt><dd>{{ formatBytes(overview.storageLimit) }}</dd></div>
        <div><dt>最近活动</dt><dd>{{ formatDateTime(overview.lastActivityTime) }}</dd></div>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 720px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.card { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 20px 24px; margin-top: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0; }
dt { font-size: 13px; color: var(--c-text-muted); }
dd { margin: 4px 0 0; font-size: 18px; font-weight: 600; color: var(--c-text); }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
</style>