<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface PoolSession {
  id: string;
  lastUsed: number;
  isExplicit: boolean;
  isAlive: boolean;
  /** 该会话当前在途查询数；0 表示空闲 */
  inFlight: number;
}

interface PoolStats {
  total: number;
  active: number;
  explicit: number;
  maxConnections: number;
  idleTimeoutMs: number;
  sessions: PoolSession[];
}

const stats = ref<PoolStats | null>(null);

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function usagePercent(): number {
  if (!stats.value) return 0;
  return Math.round((stats.value.total / stats.value.maxConnections) * 100);
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'stats') {
      stats.value = msg.stats;
    }
  });
});

onUnmounted(() => {});
</script>

<template>
  <div class="pool-panel">
    <div v-if="stats" class="summary">
      <!--
        total = 池中缓存的会话数（对应 maxConnections 上限）
        active = 其中有在途查询的会话数
        二者语义不同：此前 total 被标成 "Active Connections"，而扩展端的
        active 又与 total 同值，指标完全失真。
      -->
      <div class="stat-card">
        <div class="stat-value">{{ stats.total }} / {{ stats.maxConnections }}</div>
        <div class="stat-label">{{ t('wv.pool.totalConnections') }}</div>
        <div class="bar">
          <div class="bar-fill" :style="{ width: usagePercent() + '%' }" :class="{ warn: usagePercent() > 80 }"></div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.active }}</div>
        <div class="stat-label">{{ t('wv.pool.activeConnections') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.explicit }}</div>
        <div class="stat-label">{{ t('wv.pool.explicitPinned') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ Math.round(stats.idleTimeoutMs / 1000) }}s</div>
        <div class="stat-label">{{ t('wv.pool.idleTimeout') }}</div>
      </div>
    </div>
    <div class="session-list">
      <div class="list-header">
        <span class="col-id">{{ t('wv.pool.connection') }}</span>
        <span class="col-status">{{ t('wv.common.status') }}</span>
        <span class="col-type">{{ t('wv.common.type') }}</span>
        <span class="col-busy">{{ t('wv.pool.inFlight') }}</span>
        <span class="col-time">{{ t('wv.pool.lastUsed') }}</span>
      </div>
      <div v-for="s in stats?.sessions" :key="s.id" class="session">
        <span class="col-id">{{ s.id }}</span>
        <span class="col-status" :class="{ alive: s.isAlive, dead: !s.isAlive }">
          {{ s.isAlive ? t('wv.pool.alive') : t('wv.pool.dead') }}
        </span>
        <span class="col-type">{{ s.isExplicit ? t('wv.pool.pinned') : t('wv.pool.auto') }}</span>
        <span class="col-busy">{{ s.inFlight > 0 ? s.inFlight : '—' }}</span>
        <span class="col-time">{{ formatTime(s.lastUsed) }}</span>
      </div>
      <div v-if="!stats?.sessions.length" class="empty">{{ t('wv.pool.noActive') }}</div>
    </div>
  </div>
</template>

<style scoped>
.pool-panel { padding: 12px; height: 100%; display: flex; flex-direction: column; }
.summary { display: flex; gap: 12px; margin-bottom: 16px; }
.stat-card { flex: 1; padding: 12px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; text-align: center; }
.stat-value { font-size: 24px; font-weight: 600; color: var(--vscode-foreground); }
.stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.bar { height: 6px; background: var(--vscode-progressBar-background); border-radius: 3px; margin-top: 8px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--vscode-charts-green); border-radius: 3px; transition: width 0.3s; }
.bar-fill.warn { background: var(--vscode-charts-orange); }
.session-list { flex: 1; overflow-y: auto; }
.list-header { display: flex; gap: 8px; padding: 4px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; }
.session { display: flex; gap: 8px; padding: 4px 4px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08)); }
.col-id { flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-status { flex: 1; }
.col-status.alive { color: var(--vscode-charts-green); }
.col-status.dead { color: var(--vscode-charts-red); }
.col-type { flex: 1; }
.col-busy { flex: 1; }
.col-time { flex: 1; color: var(--vscode-descriptionForeground); }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
</style>