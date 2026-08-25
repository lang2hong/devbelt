<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 设备管理（Vue 版）：卡片式展示当前用户全部设备（主机名/系统/App 版本/最后活跃 + 绑定状态），
 * 支持撤销设备（释放配额位）。
 * 消息协议（与 src/sync/sessionView.ts 对齐）：
 *   webview → ext: ready | revoke{deviceId}
 *   ext → webview: init{mode:'session'} | devices{devices,currentDeviceId,canRevoke} | error{message}
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface DeviceItem {
  id: number;
  deviceId: string;
  hostname?: string;
  os?: string;
  arch?: string;
  osVersion?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  revokedTime?: string;
  lastSeenTime?: string;
  createTime: string;
}

const devices = ref<DeviceItem[]>([]);
const currentDeviceId = ref('');
const canRevoke = ref(true);
const errorMsg = ref('');

const boundCount = computed(() => devices.value.filter((d) => d.revokedTime == null).length);

function fmt(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function isCurrent(d: DeviceItem): boolean {
  return !!currentDeviceId.value && d.deviceId === currentDeviceId.value;
}

function isBound(d: DeviceItem): boolean {
  return d.revokedTime == null;
}

function osInitial(d: DeviceItem): string {
  if (d.os === 'darwin') return 'M';
  if (d.os === 'win32') return 'W';
  if (d.os === 'linux') return 'L';
  return ((d.os || '?')[0] || '?').toUpperCase();
}

function systemOf(d: DeviceItem): string {
  const parts = [d.os, d.arch, d.osVersion].filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
}

function appOf(d: DeviceItem): string {
  const parts = [d.appName, d.appVersion].filter(Boolean);
  return parts.length ? parts.join(' ') : '';
}

function revoke(deviceId: string) {
  post({ type: 'revoke', deviceId });
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'devices') {
      devices.value = msg.devices;
      currentDeviceId.value = msg.currentDeviceId || '';
      canRevoke.value = msg.canRevoke !== false;
      errorMsg.value = '';
    } else if (msg.type === 'error') {
      errorMsg.value = msg.message;
    }
  });
});
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
      <div v-for="d in devices" :key="d.id" class="device" :class="{ current: isCurrent(d) }">
        <div class="d-icon">{{ osInitial(d) }}</div>
        <div class="d-body">
          <div class="d-top">
            <span class="d-name">{{ d.hostname || d.deviceId }}</span>
            <span v-if="isCurrent(d)" class="tag cur">{{ t('sessions.current') }}</span>
            <span v-else class="tag" :class="isBound(d) ? 'bound' : 'unbound'">
              {{ isBound(d) ? t('sessions.bound') : t('sessions.unbound') }}
            </span>
          </div>
          <div v-if="systemOf(d)" class="d-meta">{{ systemOf(d) }}</div>
          <div v-if="appOf(d)" class="d-meta app">{{ appOf(d) }}</div>
          <div v-if="d.lastSeenTime" class="d-last">{{ t('sessions.lastUsed') }} · {{ fmt(d.lastSeenTime) }}</div>
        </div>
        <div class="d-action">
          <button v-if="!isCurrent(d) && canRevoke" class="revoke-btn" @click="revoke(d.deviceId)">{{ t('sessions.kick') }}</button>
          <span v-else-if="!isCurrent(d)" class="pro-tag">{{ t('sessions.pro') }}</span>
        </div>
      </div>
    </div>
    <div v-else class="empty">{{ t('sessions.empty') }}</div>
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.panel { padding: 24px; height: 100%; box-sizing: border-box; overflow-y: auto; }
.head { margin-bottom: 16px; }
.title { font-size: 16px; font-weight: 600; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; }

.devices { display: flex; flex-direction: column; gap: 10px; }
.device {
  display: flex; align-items: center; gap: 14px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  border-radius: 8px; padding: 14px 16px;
  background: var(--vscode-editor-background);
  transition: border-color .15s, box-shadow .15s;
}
.device.current { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }

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
.tag.cur { background: var(--vscode-focusBorder, #007acc); color: #fff; }
.tag.bound { color: var(--vscode-testing-iconPassed-color, #4ec9b0); border: 1px solid var(--vscode-testing-iconPassed-color, #4ec9b0); }
.tag.unbound { color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); }

.d-meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
.d-meta.app { font-size: 11px; }
.d-last { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; opacity: .85; }

.d-action { flex-shrink: 0; }
.revoke-btn {
  padding: 5px 12px; border: 1px solid var(--vscode-errorForeground);
  background: transparent; color: var(--vscode-errorForeground);
  border-radius: 6px; cursor: pointer; font-size: 12px;
}
.revoke-btn:hover { background: var(--vscode-errorForeground); color: #fff; }
.pro-tag { font-size: 11px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); padding: 4px 12px; border-radius: 6px; }

.empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 32px 0; font-size: 13px; }
.err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 10px; }
</style>