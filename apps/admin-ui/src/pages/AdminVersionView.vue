<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { getVersion, type ConsoleVersion } from '../api/admin';
import { setAccessToken } from '@devkit/auth-client';
import { formatDateTime } from '../lib/formatTime';

const version = ref<ConsoleVersion | null>(null);
const state = ref<'loading' | 'ready' | 'error'>('loading');

onMounted(async () => {
  const r = await getVersion();
  if (r.kind === 'ok') {
    version.value = r.value;
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
    <header class="head">
      <h2>系统状态</h2>
      <p class="sub">版本与运行状态。</p>
    </header>
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>
    <table v-if="state === 'ready' && version" class="table">
      <tbody>
        <tr><th>Console API 版本</th><td>{{ version.consoleApiVersion }}</td></tr>
        <tr><th>服务端版本</th><td>{{ version.serverVersion }}</td></tr>
        <tr><th>前端构建号</th><td>{{ version.consoleBuildId ?? '—' }}</td></tr>
        <tr><th>构建时间</th><td>{{ formatDateTime(version.buildTime) }}</td></tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.page { max-width: 960px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.table { width: 100%; border-collapse: collapse; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; }
th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #eaeef2; font-size: 14px; }
th { width: 200px; color: var(--c-text-muted); font-weight: 600; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.head { margin-bottom: 16px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
</style>