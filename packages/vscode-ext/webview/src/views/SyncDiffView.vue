<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

interface MergeItemChange { id: string; kind: 'added' | 'updated' | 'deleted'; label: string; detail?: string }
interface MergeSection { added: number; updated: number; deleted: number; localOnly: number; items: MergeItemChange[] }
interface MergePlan {
  hasLocalUnpushed: boolean;
  connections: MergeSection;
  queries: MergeSection;
  folders: MergeSection;
  history: { added: number; merged: number };
}

const plan = ref<MergePlan | null>(null);
const state = ref<'loading' | 'ready' | 'applying' | 'error'>('loading');
const errorMsg = ref('');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'plan') { plan.value = msg.plan; state.value = 'ready'; }
    else if (msg.type === 'applied') { state.value = 'applying'; }
    else if (msg.type === 'error') { errorMsg.value = msg.message; state.value = 'error'; }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

const sections = computed(() => {
  if (!plan.value) return [];
  const p = plan.value;
  return [
    { key: 'connections', title: 'Connections', s: p.connections },
    { key: 'queries', title: 'Saved Queries', s: p.queries },
    { key: 'folders', title: 'Query Folders', s: p.folders },
  ].filter((x) => x.s.items.length > 0);
});

const historyText = computed(() => {
  if (!plan.value) return '';
  const h = plan.value.history;
  if (h.added === 0 && h.merged === 0) return '';
  return `${h.added} new, ${h.merged} merged`;
});

const totalChanges = computed(() => {
  if (!plan.value) return 0;
  const c = plan.value;
  return c.connections.added + c.connections.updated + c.connections.deleted
    + c.queries.added + c.queries.updated + c.queries.deleted
    + c.folders.added + c.folders.updated + c.folders.deleted
    + c.history.added;
});

function kindLabel(k: string) { return k.charAt(0).toUpperCase() + k.slice(1); }
function apply() { state.value = 'applying'; post({ type: 'apply' }); }
function cancel() { post({ type: 'cancel' }); }
</script>

<template>
  <div class="app">
    <div class="header">
      <h2>Sync Diff Preview</h2>
      <span class="count" v-if="plan">{{ totalChanges }} change(s)</span>
    </div>

    <div class="banner warn" v-if="plan?.hasLocalUnpushed">
      Local has unpushed changes — merge keeps newer items locally. Push after to sync your local changes.
    </div>

    <div class="state loading" v-if="state === 'loading'">Loading remote data…</div>
    <div class="state error" v-else-if="state === 'error'">{{ errorMsg }}</div>
    <template v-else-if="plan">
      <div class="empty" v-if="totalChanges === 0 && !historyText">
        Already up to date. Nothing to merge.
      </div>
      <template v-else>
        <div class="section" v-for="sec in sections" :key="sec.key">
          <div class="section-title">
            <span>{{ sec.title }}</span>
            <span class="summary">
              <span class="add" v-if="sec.s.added">+{{ sec.s.added }}</span>
              <span class="upd" v-if="sec.s.updated">~{{ sec.s.updated }}</span>
              <span class="del" v-if="sec.s.deleted">-{{ sec.s.deleted }}</span>
              <span class="loc" v-if="sec.s.localOnly">local:{{ sec.s.localOnly }}</span>
            </span>
          </div>
          <table>
            <tbody>
              <tr v-for="item in sec.s.items" :key="item.id" :class="item.kind">
                <td class="kind">{{ kindLabel(item.kind) }}</td>
                <td class="label">{{ item.label }}</td>
                <td class="detail">{{ item.detail }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="section" v-if="historyText">
          <div class="section-title"><span>Query History</span><span class="summary">{{ historyText }}</span></div>
        </div>

        <div class="actions">
          <button class="btn primary" :disabled="state === 'applying'" @click="apply">
            {{ state === 'applying' ? 'Applying…' : 'Apply Merge' }}
          </button>
          <button class="btn" :disabled="state === 'applying'" @click="cancel">Cancel</button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #cccccc); }
.header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.count { color: var(--vscode-descriptionForeground, #808080); font-size: 12px; }
.banner { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.banner.warn { background: var(--vscode-inputOption-activeBorder, rgba(204,153,0,0.08)); color: var(--vscode-descriptionForeground, #808080); }
.state { padding: 16px 12px; font-size: 13px; }
.state.error { color: var(--vscode-errorForeground, #f48771); }
.empty { padding: 16px 12px; color: var(--vscode-descriptionForeground, #808080); font-size: 13px; }
.section { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.section-title { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground, #808080); }
.summary { display: flex; gap: 8px; font-weight: 500; }
.summary .add { color: var(--vscode-testing-iconPassed-color, #3fb950); }
.summary .upd { color: var(--vscode-charts-yellow, #d29922); }
.summary .del { color: var(--vscode-errorForeground, #f85149); }
.summary .loc { color: var(--vscode-descriptionForeground, #808080); opacity: 0.7; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 10px; text-align: left; }
td.kind { width: 80px; font-weight: 600; white-space: nowrap; }
td.label { white-space: nowrap; }
td.detail { color: var(--vscode-descriptionForeground, #808080); white-space: nowrap; }
tr.added td.kind { color: var(--vscode-testing-iconPassed-color, #3fb950); }
tr.updated td.kind { color: var(--vscode-charts-yellow, #d29922); }
tr.deleted td.kind { color: var(--vscode-errorForeground, #f85149); }
.actions { display: flex; gap: 8px; padding: 10px 12px; }
.btn { padding: 5px 14px; font-size: 12px; cursor: pointer; border: 1px solid var(--vscode-input-border, #3c3c3c);
  background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border-radius: 3px; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); border-color: transparent; }
</style>
