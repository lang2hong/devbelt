<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 设备管理（Vue 版）：展示当前用户全部设备（平台/客户端版本/最后活跃/状态），
 * 支持撤销设备。
 * 消息协议（与 src/sync/sessionView.ts 对齐）：
 *   webview → ext: ready | revoke{deviceId}
 *   ext → webview: init{mode:'session'} | devices{devices,canRevoke} | error{message}
 */
const { post, onMessage } = useVsCode();
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
const errorMsg = ref('');

const boundCount = computed(() => devices.value.filter((d) => d.status === 'active').length);

function fmt(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
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

function revoke(deviceId: string) {
  post({ type: 'revoke', deviceId });
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'devices') {
      devices.value = msg.devices ?? [];
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
      <div v-for="d in devices" :key="d.deviceId" class="device">
        <div class="d-icon">{{ osInitial(d) }}</div>
        <div class="d-body">
          <div class="d-top">
            <span class="d-name">{{ d.deviceName || d.deviceId }}</span>
            <span class="tag" :class="isBound(d) ? 'bound' : 'unbound'">
              {{ isBound(d) ? t('sessions.bound') : t('sessions.unbound') }}
            </span>
          </div>
          <div v-if="d.clientVersion" class="d-meta">v{{ d.clientVersion }}</div>
          <div v-if="d.lastUsedTime" class="d-last">{{ t('sessions.lastUsed') }} · {{ fmt(d.lastUsedTime) }}</div>
        </div>
        <div class="d-action">
          <button v-if="canRevoke" class="revoke-btn" @click="revoke(d.deviceId)">{{ t('sessions.kick') }}</button>
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
.revoke-btn:hover { background: var(--vscode-errorForeground); color: #fff; }

.empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 32px 0; font-size: 13px; }
.err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 10px; }
</style>