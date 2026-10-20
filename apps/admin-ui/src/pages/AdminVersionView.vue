<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { getVersion, type ConsoleVersion } from '../api/admin';
import { setAccessToken } from '@devbelt/auth-client';
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
      <p class="sub">当前部署的版本、构建号与构建时间。</p>
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
</style>