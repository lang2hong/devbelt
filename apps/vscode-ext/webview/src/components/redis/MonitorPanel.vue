<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import Sparkline from './Sparkline.vue';
import type { RedisMonitorMetrics } from '../../../../src/result/protocol';

const props = defineProps<{ metrics: RedisMonitorMetrics | null; samples: RedisMonitorMetrics[] }>();
const emit = defineEmits<{ (e: 'sample'): void }>();
const { t } = useI18n();

const intervalMs = ref(2000);
const paused = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

function stop(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
function start(): void {
  stop();
  if (paused.value) return;
  timer = setInterval(() => emit('sample'), intervalMs.value);
}
function toggle(): void {
  paused.value = !paused.value;
  if (paused.value) stop();
  else { emit('sample'); start(); }
}

onMounted(() => { emit('sample'); start(); });
onUnmounted(stop);
watch(intervalMs, () => { if (!paused.value) start(); });

const m = computed(() => props.metrics);
const memorySeries = computed(() => props.samples.map((s) => s.usedMemory));
const opsSeries = computed(() => props.samples.map((s) => s.instantaneousOpsPerSec));
const clientsSeries = computed(() => props.samples.map((s) => s.connectedClients));
const netInSeries = computed(() => props.samples.map((s) => s.instantaneousInputKbps));
const netOutSeries = computed(() => props.samples.map((s) => s.instantaneousOutputKbps));
const hitRateSeries = computed<(number | null)[]>(() => props.samples.map((s) => (s.hitRate === null ? null : s.hitRate * 100)));
const memoryPct = computed<number | null>(() => {
  const v = m.value;
  if (!v || v.maxmemory <= 0) return null;
  return Math.min(100, (v.usedMemory / v.maxmemory) * 100);
});
const lastSampleText = computed(() => {
  const ts = m.value?.ts ?? 0;
  return ts > 0 ? new Date(ts).toLocaleTimeString() : '—';
});

function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (!n) return '0 B';
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
function fmtDuration(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${min}m` : `${min}m`;
}
function fmtNum(n: number): string {
  return n.toLocaleString();
}
function fmtRate(r: number | null): string {
  return r === null ? '-' : `${(r * 100).toFixed(1)}%`;
}
</script>

<template>
  <div class="monitor">
    <div class="toolbar">
      <button class="btn" @click="toggle">
        {{ paused ? t('wv.redis.monitor.resume') : t('wv.redis.monitor.pause') }}
      </button>
      <select v-model.number="intervalMs" :disabled="paused">
        <option :value="1000">1s</option>
        <option :value="2000">2s</option>
        <option :value="5000">5s</option>
      </select>
      <span v-if="m" class="sample-time">{{ t('wv.redis.monitor.lastSample', { time: lastSampleText }) }}</span>
    </div>
    <div v-if="!m" class="empty">{{ t('wv.redis.monitor.empty') }}</div>
    <div v-else class="body">
      <div class="section-title">{{ t('wv.redis.monitor.trends') }}</div>
      <div class="trends">
        <div class="trend">
          <div class="row">
            <span class="lbl">{{ t('wv.redis.monitor.memory') }}</span>
            <span class="val">{{ fmtBytes(m.usedMemory) }}<template v-if="memoryPct !== null"> · {{ memoryPct.toFixed(1) }}%</template></span>
          </div>
          <div v-if="memoryPct !== null" class="usage-bar" :title="t('wv.redis.monitor.memoryUsage')">
            <div class="usage-fill" :style="{ width: `${memoryPct}%` }" />
          </div>
          <Sparkline :points="memorySeries" />
        </div>
        <div class="trend">
          <div class="row"><span class="lbl">{{ t('wv.redis.monitor.ops') }}</span><span class="val">{{ fmtNum(m.instantaneousOpsPerSec) }}</span></div>
          <Sparkline :points="opsSeries" color="var(--vscode-charts-green, #89d185)" />
        </div>
        <div class="trend">
          <div class="row"><span class="lbl">{{ t('wv.redis.monitor.clients') }}</span><span class="val">{{ fmtNum(m.connectedClients) }}</span></div>
          <Sparkline :points="clientsSeries" color="var(--vscode-charts-purple, #b180d7)" />
        </div>
        <div class="trend">
          <div class="row"><span class="lbl">{{ t('wv.redis.monitor.netIn') }}</span><span class="val">{{ m.instantaneousInputKbps.toFixed(1) }}</span></div>
          <Sparkline :points="netInSeries" color="var(--vscode-charts-yellow, #d7ba7d)" />
        </div>
        <div class="trend">
          <div class="row"><span class="lbl">{{ t('wv.redis.monitor.netOut') }}</span><span class="val">{{ m.instantaneousOutputKbps.toFixed(1) }}</span></div>
          <Sparkline :points="netOutSeries" color="var(--vscode-charts-orange, #d18616)" />
        </div>
        <div class="trend">
          <div class="row"><span class="lbl">{{ t('wv.redis.monitor.hitRate') }}</span><span class="val">{{ fmtRate(m.hitRate) }}</span></div>
          <Sparkline :points="hitRateSeries" color="var(--vscode-charts-red, #f48771)" />
        </div>
      </div>

      <div class="section-title">{{ t('wv.redis.monitor.overview') }}</div>
      <div class="cards">
        <div class="card"><div class="k">{{ t('wv.redis.monitor.version') }}</div><div class="v">{{ m.version || '-' }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.role') }}</div><div class="v">{{ m.role || '-' }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.uptime') }}</div><div class="v">{{ fmtDuration(m.uptimeSeconds) }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.maxmemory') }}</div><div class="v">{{ m.maxmemory > 0 ? fmtBytes(m.maxmemory) : t('wv.redis.monitor.noLimit') }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.fragmentation') }}</div><div class="v">{{ m.fragmentationRatio.toFixed(2) }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.evicted') }}</div><div class="v">{{ fmtNum(m.evictedKeys) }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.expired') }}</div><div class="v">{{ fmtNum(m.expiredKeys) }}</div></div>
        <div class="card"><div class="k">{{ t('wv.redis.monitor.totalCommands') }}</div><div class="v">{{ fmtNum(m.totalCommandsProcessed) }}</div></div>
      </div>

      <template v-if="m.keyspace.length">
        <div class="section-title">{{ t('wv.redis.monitor.keyspace') }}</div>
        <div class="keyspace">
          <div class="ks ks-head">
            <span class="db">{{ t('wv.redis.monitor.db') }}</span>
            <span>{{ t('wv.redis.monitor.keys') }}</span>
            <span class="expires">{{ t('wv.redis.monitor.expires') }}</span>
          </div>
          <div v-for="ks in m.keyspace" :key="ks.db" class="ks">
            <span class="db">{{ ks.db }}</span>
            <span>{{ fmtNum(ks.keys) }}</span>
            <span class="expires">{{ fmtNum(ks.expires) }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.monitor { display: flex; flex-direction: column; height: 100%; overflow-y: auto; }
.toolbar { display: flex; gap: 6px; align-items: center; padding-bottom: 6px; flex-wrap: wrap; }
.sample-time { color: var(--vscode-descriptionForeground); font-size: 11px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
select { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.section-title { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.trends { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.trend { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); border-radius: 4px; padding: 6px 8px; }
.trend .row { display: flex; justify-content: space-between; font-size: 12px; }
.trend .lbl { color: var(--vscode-descriptionForeground); }
.trend .val { font-variant-numeric: tabular-nums; }
.usage-bar { height: 4px; margin: 3px 0 2px; border-radius: 2px; overflow: hidden; background: var(--vscode-panel-border, rgba(128,128,128,0.25)); }
.usage-fill { height: 100%; background: var(--vscode-charts-blue, #3794ff); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); border-radius: 4px; padding: 6px 8px; }
.card .k { font-size: 11px; color: var(--vscode-descriptionForeground); }
.card .v { font-size: 14px; font-variant-numeric: tabular-nums; }
.keyspace { display: flex; flex-direction: column; gap: 2px; }
.ks { display: flex; gap: 10px; font-variant-numeric: tabular-nums; }
.ks .db { color: var(--vscode-descriptionForeground); width: 48px; }
.ks .expires { color: var(--vscode-descriptionForeground); }
.ks-head { color: var(--vscode-descriptionForeground); font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
</style>