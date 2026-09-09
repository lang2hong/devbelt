<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { syncOverview, type SyncOverview } from '../api/sync';
import { setAccessToken } from '../api/consoleAuth';

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
    window.location.assign('/login');
  } else {
    state.value = 'error';
  }
});
</script>

<template>
  <section class="page">
    <h2>同步</h2>
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <div v-if="state === 'ready' && overview" class="card">
      <p v-if="!overview.initialized" class="muted">尚未初始化同步。</p>
      <dl v-else class="grid">
        <div><dt>活跃记录</dt><dd>{{ overview.activeRecordCount }}</dd></div>
        <div><dt>密文体积</dt><dd>{{ formatBytes(overview.ciphertextBytes) }}</dd></div>
        <div><dt>记录配额</dt><dd>{{ overview.recordLimit ? overview.recordLimit : '不限' }}</dd></div>
        <div><dt>存储配额</dt><dd>{{ formatBytes(overview.storageLimit) }}</dd></div>
        <div><dt>最近活动</dt><dd>{{ overview.lastActivityTime ? new Date(overview.lastActivityTime).toLocaleString() : '—' }}</dd></div>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-top: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0; }
dt { font-size: 13px; color: #57606a; }
dd { margin: 4px 0 0; font-size: 18px; font-weight: 600; color: #0f172a; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
</style>