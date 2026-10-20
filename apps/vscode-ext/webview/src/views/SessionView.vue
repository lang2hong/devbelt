<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { formatDateTime } from '../utils/formatTime';

/**
 * 设备管理（Vue 版）：展示当前用户全部设备（平台/客户端版本/最后活跃/状态），
 * 支持撤销设备。
 * 消息协议（与 src/sync/sessionView.ts 对齐）：
 *   webview → ext: ready | revoke{deviceId}
 *   ext → webview: init{mode:'session'} | devices{devices,canRevoke} | error{message}
 */
const { post, onMessage } = useVsCode();
let __offMsg: (() => void) | undefined;
const { t } = useI18n();

interface DeviceItem {
  deviceId: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string;
  status: 'active' | 'revoked';
  lastUsedTime: string | null;
  createTime: string;
}

const devices = ref<DeviceItem[]>([]);
const canRevoke = ref(true);
const currentDeviceId = ref<string | null>(null);
const pendingRevoke = ref<DeviceItem | null>(null);
const errorMsg = ref('');

const boundCount = computed(() => devices.value.filter((d) => d.status === 'active').length);
const sortedDevices = computed(() => [...devices.value].sort((a, b) => {
  if (a.deviceId === currentDeviceId.value) return -1;
  if (b.deviceId === currentDeviceId.value) return 1;
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  return (b.lastUsedTime ?? '').localeCompare(a.lastUsedTime ?? '');
}));

function isCurrent(d: DeviceItem): boolean {
  return !!currentDeviceId.value && d.deviceId === currentDeviceId.value;
}

function isBound(d: DeviceItem): boolean {
  return d.status === 'active';
}

function osInitial(d: DeviceItem): string {
  if (d.devicePlatform === 'darwin') return 'M';
  if (d.devicePlatform === 'win32') return 'W';
  if (d.devicePlatform === 'linux') return 'L';
  return ((d.devicePlatform || '?')[0] || '?').toUpperCase();
}

function revoke(d: DeviceItem): void {
  pendingRevoke.value = d;
}

function confirmRevoke(): void {
  const d = pendingRevoke.value;
  if (!d) return;
  pendingRevoke.value = null;
  post({ type: 'revoke', deviceId: d.deviceId });
}

onMounted(() => {
  post({ type: 'ready', view: 'session' });
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'devices') {
      devices.value = msg.devices ?? [];
      canRevoke.value = msg.canRevoke !== false;
      currentDeviceId.value = typeof msg.currentDeviceId === 'string' ? msg.currentDeviceId : null;
      errorMsg.value = '';
    } else if (msg.type === 'error') {
      errorMsg.value = msg.message;
    }
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="panel">
    <header class="head">
      <div class="title">{{ t('sessions.title') }}</div>
      <div class="sub">
        {{ devices.length }} {{ t('sessions.device') }} · {{ boundCount }} {{ t('sessions.bound') }}
      </div>
    </header>

    <div class="devices" v-if="devices.length">
      <div v-for="d in sortedDevices" :key="d.deviceId" class="device" :class="{ current: isCurrent(d) }">
        <div class="d-icon">{{ osInitial(d) }}</div>
        <div class="d-body">
          <div class="d-top">
            <span class="d-name">{{ d.deviceName || d.deviceId }}</span>
            <span v-if="isCurrent(d)" class="tag current-tag">{{ t('sessions.current') }}</span>
            <span class="tag" :class="isBound(d) ? 'bound' : 'unbound'">
              {{ isBound(d) ? t('sessions.bound') : t('sessions.unbound') }}
            </span>
          </div>
          <div v-if="d.clientVersion" class="d-meta">v{{ d.clientVersion }}</div>
          <div v-if="d.lastUsedTime" class="d-last">{{ t('sessions.lastUsed') }} · {{ formatDateTime(d.lastUsedTime) }}</div>
        </div>
        <div class="d-action">
          <button v-if="canRevoke && !isCurrent(d)" class="revoke-btn" @click="revoke(d)">{{ t('sessions.kick') }}</button>
        </div>
        <div v-if="pendingRevoke?.deviceId === d.deviceId" class="confirm">
          <span>{{ t('sessions.revokeConfirm') }}</span>
          <button class="revoke-btn" @click="confirmRevoke">{{ t('sessions.kick') }}</button>
          <button class="cancel-btn" @click="pendingRevoke = null">{{ t('wv.common.cancel') }}</button>
        </div>
      </div>
    </div>
    <div v-else class="empty">{{ t('sessions.empty') }}</div>
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.panel { padding: 16px; height: 100%; box-sizing: border-box; overflow-y: auto; }
.head { margin-bottom: 16px; }
.title { font-size: 16px; font-weight: 600; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; }

.devices { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
.device {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  border-radius: 8px; padding: 14px 16px;
  background: var(--vscode-editor-background);
}

.d-icon {
  width: 40px; height: 40px; border-radius: 9px; flex-shrink: 0;
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.15));
  color: var(--vscode-focusBorder, #007acc);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 16px;
}

.d-body { flex: 1; min-width: 0; }
.d-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.d-name { font-weight: 600; font-size: 13px; }
.tag { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; line-height: 1.4; }
.device.current { border-color: var(--vscode-focusBorder, #007acc); }
.current-tag { color: var(--vscode-focusBorder, #007acc); border: 1px solid var(--vscode-focusBorder, #007acc); }
.tag.bound { color: var(--vscode-testing-iconPassed-color, #4ec9b0); border: 1px solid var(--vscode-testing-iconPassed-color, #4ec9b0); }
.tag.unbound { color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); }

.d-meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
.d-last { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; opacity: .85; }

.d-action { flex-shrink: 0; }
.revoke-btn {
  padding: 5px 12px; border: 1px solid var(--vscode-errorForeground);
  background: transparent; color: var(--vscode-errorForeground);
  border-radius: 6px; cursor: pointer; font-size: 12px;
}
.revoke-btn:hover { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }

.confirm { flex-basis: 100%; display: flex; align-items: center; gap: 8px; justify-content: flex-end; font-size: 12px; color: var(--vscode-descriptionForeground); }
.cancel-btn { padding: 5px 12px; border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.4)); background: transparent; color: var(--vscode-foreground); border-radius: 6px; cursor: pointer; font-size: 12px; }
.empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 32px 0; font-size: 13px; }
.err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 10px; }
</style>