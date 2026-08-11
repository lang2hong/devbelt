<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();
const tab = ref<'process' | 'status' | 'vars'>('process');
const processList = ref<any[]>([]);
const statusVars = ref<any[]>([]);
const serverVars = ref<any[]>([]);
const summary = ref<any>(null);
const error = ref('');
const search = ref('');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'data') {
      processList.value = msg.processList || [];
      statusVars.value = msg.statusVars || [];
      serverVars.value = msg.serverVars || [];
      summary.value = msg.summary || null;
      error.value = '';
    } else if (msg.type === 'processList') {
      processList.value = msg.processList || [];
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

const filteredStatus = computed(() => {
  if (!search.value) return statusVars.value;
  return statusVars.value.filter(r => JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()));
});
const filteredVars = computed(() => {
  if (!search.value) return serverVars.value;
  return serverVars.value.filter(r => JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()));
});

const processRows = computed(() => {
  if (!search.value) return processList.value;
  const s = search.value.toLowerCase();
  return processList.value.filter(r => {
    for (const [k, v] of Object.entries(r)) {
      if (/user|host|db|usename|client|datname|id|pid/i.test(k) && String(v).toLowerCase().includes(s)) return true;
    }
    return false;
  });
});

function processIdOf(row: any): number | undefined {
  const v = row.Id ?? row.id ?? row.pid ?? row.PID ?? row.ID;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function killProcess(row: any) {
  const id = processIdOf(row);
  if (id === undefined) return;
  post({ type: 'killProcess', id });
}

function flatten(rows: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const keys = Object.keys(r);
    const k = String(r.Variable_name ?? r.name ?? keys[0] ?? '');
    const v = r.Value ?? r.value ?? (keys.length > 1 ? r[keys[1]] : r[keys[0]]);
    if (k) m.set(k.toLowerCase(), String(v ?? ''));
  }
  return m;
}
const varMap = computed(() => {
  const m = flatten(serverVars.value);
  for (const [k, v] of flatten(statusVars.value)) m.set(k, v);
  return m;
});
const keyVars = computed(() => {
  const defs = [
    { label: 'Version', key: 'version' },
    { label: 'Charset', key: 'character_set_server' },
    { label: 'Collation', key: 'collation_server' },
    { label: 'Timezone', key: 'time_zone' },
    { label: 'Max Connections', key: 'max_connections' },
    { label: 'Active Threads', key: 'threads_connected' },
    { label: 'Uptime (s)', key: 'uptime' },
    { label: 'Slow Queries', key: 'slow_queries' },
    { label: 'Engine', key: 'default_storage_engine' },
    { label: 'Hostname', key: 'hostname' },
    { label: 'Port', key: 'port' },
    { label: 'Data Dir', key: 'datadir' },
  ];
  return defs.map(d => ({ ...d, value: varMap.value.get(d.key.toLowerCase()) || '' }))
    .filter(d => d.value);
});
</script>

<template>
  <div class="app">
    <div class="summary" v-if="summary">
      <span class="badge">{{ summary.dbType }}</span>
      <span v-if="summary.version" class="kv"><b>Version</b> {{ summary.version }}</span>
      <span v-if="summary.host" class="kv"><b>Host</b> {{ summary.host }}<template v-if="summary.port">:{{ summary.port }}</template></span>
      <span v-if="summary.currentUser" class="kv"><b>User</b> {{ summary.currentUser }}</span>
      <span v-if="summary.database" class="kv"><b>Database</b> {{ summary.database }}</span>
    </div>
    <div class="dashboard" v-if="keyVars.length">
      <div class="kv-cell" v-for="kv in keyVars" :key="kv.key">
        <span class="kv-label">{{ kv.label }}</span>
        <span class="kv-val">{{ kv.value }}</span>
      </div>
    </div>
    <div class="tabs">
      <button :class="{ active: tab === 'process' }" @click="tab = 'process'">Process ({{ processList.length }})</button>
      <button :class="{ active: tab === 'status' }" @click="tab = 'status'">Status ({{ statusVars.length }})</button>
      <button :class="{ active: tab === 'vars' }" @click="tab = 'vars'">Variables ({{ serverVars.length }})</button>
    </div>
    <div class="search">
      <input v-model="search" :placeholder="tab === 'process' ? 'Filter user/host/db/id...' : 'Filter...'" class="input" />
    </div>
    <div class="error" v-if="error">{{ error }}</div>
    <div class="content" v-else>
      <!-- Process List -->
      <table v-if="tab === 'process' && processRows.length">
        <thead>
          <tr>
            <th v-for="k in Object.keys(processRows[0])" :key="k">{{ k }}</th>
            <th class="act-col">Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in processRows" :key="i">
            <td v-for="k in Object.keys(processRows[0])" :key="k">{{ row[k] }}</td>
            <td><button v-if="processIdOf(row) !== undefined" class="btn-kill" @click="killProcess(row)">Kill</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'process'">No processes.</p>
      <!-- Status Variables -->
      <table v-if="tab === 'status' && filteredStatus.length">
        <thead><tr><th v-for="k in Object.keys(filteredStatus[0])" :key="k">{{ k }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in filteredStatus" :key="i">
            <td v-for="k in Object.keys(filteredStatus[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'status'">No status variables. (MySQL only)</p>
      <!-- Server Variables -->
      <table v-if="tab === 'vars' && filteredVars.length">
        <thead><tr><th v-for="k in Object.keys(filteredVars[0])" :key="k">{{ k }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in filteredVars" :key="i">
            <td v-for="k in Object.keys(filteredVars[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'vars'">No variables.</p>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); }
.summary { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; align-items: center; }
.summary .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 3px; font-weight: 600; }
.summary .kv b { color: var(--vscode-descriptionForeground); margin-right: 4px; font-weight: 500; }
.dashboard { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 16px;
  padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.kv-cell { display: flex; flex-direction: column; gap: 2px; font-size: 12px; min-width: 0; }
.kv-label { color: var(--vscode-descriptionForeground); }
.kv-val { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
.tabs button { padding: 6px 16px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
.search { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.input { width: 100%; box-sizing: border-box; font-size: 12px; padding: 4px 8px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.content { flex: 1; overflow: auto; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { background: var(--vscode-editor-background); position: sticky; top: 0; }
.act-col { width: 60px; text-align: center; }
.btn-kill { cursor: pointer; font-size: 11px; padding: 2px 8px;
  background: var(--vscode-errorBackground, rgba(204,0,0,0.1)); color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; }
p { padding: 12px; color: var(--vscode-descriptionForeground); }
.error { padding: 12px; color: var(--vscode-errorForeground); }
</style>
