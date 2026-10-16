<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { listDevices, revokeDevice, type Device } from '../api/devices';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';

const devices = ref<Device[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const revoking = ref<string | null>(null);
const confirming = ref<string | null>(null);

const revokeWrite = useIdempotencyKey();

async function load(): Promise<void> {
  state.value = 'loading';
  const r = await listDevices();
  if (r.kind === 'ok') {
    devices.value = r.devices;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign('/login');
  } else {
    state.value = 'error';
  }
}

onMounted(load);

function requestRevoke(d: Device): void {
  confirming.value = d.deviceId;
}

function cancelRevoke(): void {
  confirming.value = null;
}

async function confirmRevoke(d: Device): Promise<void> {
  if (revoking.value) return;
  revoking.value = d.deviceId;
  error.value = '';
  const tag = `device:${d.deviceId}`;
  try {
    const csrf = await ensureCsrf();
    const r = await revokeDevice(d.deviceId, revokeWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      revokeWrite.reset(tag);
      confirming.value = null;
      if (r.currentSessionRevoked) {
        setAccessToken(null);
        window.location.assign('/login');
        return;
      }
      await load();
    } else if (r.kind === 'unauthorized') {
      revokeWrite.reset(tag);
      setAccessToken(null);
      window.location.assign('/login');
    } else if (isRetryableFailure(r.kind)) {
      error.value = '撤销失败，请重试。';
    } else {
      revokeWrite.reset(tag);
      error.value = '撤销失败，请重试。';
    }
  } finally {
    revoking.value = null;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>设备</h2>
      <p class="sub">查看并撤销已登录的设备。</p>
    </header>
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <template v-if="state === 'ready'">
      <p v-if="devices.length === 0" class="muted">暂无已登录设备。</p>
      <ul class="list">
        <li v-for="d in devices" :key="d.deviceId" class="item">
          <div class="meta">
            <strong>{{ d.deviceName || d.devicePlatform }}</strong>
            <span class="muted">{{ d.devicePlatform }} · 上次使用 {{ formatDateTime(d.lastUsedTime) }}</span>
          </div>
          <div v-if="confirming === d.deviceId" class="confirm">
            <span class="muted">撤销该设备？</span>
            <button class="btn danger" :disabled="revoking !== null" @click="confirmRevoke(d)">撤销</button>
            <button class="btn secondary" @click="cancelRevoke">取消</button>
          </div>
          <button v-else class="btn secondary" @click="requestRevoke(d)">撤销</button>
        </li>
      </ul>
      <p v-if="error" class="error">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.list { list-style: none; padding: 0; margin: 16px 0 0; }
.item { display: flex; align-items: center; justify-content: space-between; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
.meta { display: flex; flex-direction: column; gap: 2px; }
.confirm { display: flex; align-items: center; gap: 8px; }
</style>