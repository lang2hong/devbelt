<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { t } from '../composables/useI18n';
import { formatDateTime } from '../utils/formatTime';
import type { SyncConflictView, SyncDoctorResultMessage, SyncDoctorSnapshotMessage, SyncFindingView } from '../../../src/result/protocol';

/**
 * S7k.8 数据体检面板：发现 → 用户选择。
 *
 * 扩展下发快照（发现/冲突列表）；面板只渲染与转发用户动作（修复勾选/逐条冲突决策），
 * 自身不做任何数据修改。文案全部走共享 catalog（t()），零内部术语。
 */
const { post, onMessage } = useVsCode();

const checking = ref(false);
const locked = ref(false);
const incomplete = ref(false);
const findings = ref<SyncFindingView[]>([]);
const conflicts = ref<SyncConflictView[]>([]);
const lastCheckAt = ref<number | undefined>();
const resultBanner = ref<string | undefined>();

const total = computed(() => findings.value.length + conflicts.value.length);
const consistent = computed(() => !locked.value && total.value === 0 && !incomplete.value);

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg?.type === 'syncDoctorSnapshot') {
      const snap = msg as SyncDoctorSnapshotMessage;
      checking.value = snap.checking;
      locked.value = !!snap.locked;
      incomplete.value = snap.incomplete;
      findings.value = snap.findings ?? [];
      conflicts.value = snap.conflicts ?? [];
      lastCheckAt.value = snap.lastCheckAt;
    } else if (msg?.type === 'syncDoctorResult') {
      const r = msg as SyncDoctorResultMessage;
      resultBanner.value = r.failed > 0
        ? t('sync.doctorResultPartial', { repaired: r.repaired, failed: r.failed })
        : t('sync.doctorResult', { repaired: r.repaired });
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

function typeName(type: string): string {
  return t(`sync.entity.${type}`);
}

function findingTitle(f: SyncFindingView): string {
  const name = f.kind === 'missing' ? (f.remoteValue ?? '') : (f.localValue ?? f.remoteValue ?? '');
  switch (f.kind) {
    case 'missing':
      return t('sync.find.missing', { type: typeName(f.type), name });
    case 'nameDrift':
      return t('sync.find.nameDrift', { type: typeName(f.type), name: f.localValue ?? '' });
    case 'refDrift':
      return t('sync.find.refDrift', { type: typeName(f.type), name: f.localValue ?? f.remoteValue ?? '' });
    case 'orphanDelete':
      return t('sync.find.orphanDelete', { type: typeName(f.type), name: f.localValue ?? '' });
    case 'remoteDeleted':
      return t('sync.find.remoteDeleted', { type: typeName(f.type), name: f.localValue ?? '' });
    case 'orphanGroup':
      return t('sync.find.orphanGroup', { name: f.localValue ?? '' });
  }
}

function findingDetail(f: SyncFindingView): string | undefined {
  if (f.kind === 'nameDrift') return t('sync.find.nameDetail', { local: f.localValue ?? '—', remote: f.remoteValue ?? '—' });
  if (f.kind === 'refDrift' && f.ref) {
    return t('sync.find.refDetail', {
      field: t(`sync.field.${f.ref.field}`),
      local: f.ref.local ?? '—',
      remote: f.ref.remote ?? '—',
    });
  }
  if (f.kind === 'missing' && f.remoteValue) return t('sync.find.nameDetail', { local: '—', remote: f.remoteValue });
  if (f.kind === 'orphanDelete' && f.remoteValue) return t('sync.find.nameDetail', { local: f.localValue ?? '—', remote: f.remoteValue });
  return undefined;
}

/** 各类发现对应的修复按钮文案。 */
function repairLabel(kind: SyncFindingView['kind']): string {
  switch (kind) {
    case 'missing': return t('sync.find.restore');
    case 'nameDrift':
    case 'refDrift': return t('sync.find.useCloud');
    case 'orphanDelete': return t('sync.find.restoreItem');
    case 'remoteDeleted': return t('sync.find.deleteLocal');
    case 'orphanGroup': return t('sync.find.deleteGroup');
  }
}

function refresh(): void {
  resultBanner.value = undefined;
  post({ type: 'syncDoctorRefresh' });
}

function repairOne(f: SyncFindingView): void {
  resultBanner.value = undefined;
  post({ type: 'syncDoctorRepair', ids: [f.id] });
}

function repairAll(): void {
  resultBanner.value = undefined;
  post({ type: 'syncDoctorRepair' });
}

function resolveConflict(recordId: string, decision: 'local' | 'merge' | 'remote'): void {
  post({ type: 'syncDoctorResolveConflict', recordId, decision });
}

function formatCheckTime(at?: number): string {
  return formatDateTime(at);
}
</script>

<template>
  <div class="doctor">
    <header class="doctor-head">
      <h2>{{ t('sync.doctorTitle') }}</h2>
      <button class="btn" :disabled="checking" @click="refresh">{{ checking ? t('sync.doctorChecking') : t('sync.doctorRecheck') }}</button>
    </header>

    <p v-if="locked" class="state locked">{{ t('sync.requiresUnlock') }}</p>
    <p v-else-if="checking" class="state">{{ t('sync.doctorChecking') }}</p>
    <p v-else-if="incomplete" class="state warn">{{ t('sync.doctorIncomplete') }}</p>
    <p v-else-if="consistent" class="state ok">{{ t('sync.doctorConsistent') }}</p>
    <p v-else class="state warn">{{ t('sync.doctorFound', { count: total }) }}</p>

    <p v-if="resultBanner" class="result">{{ resultBanner }}</p>

    <section v-if="findings.length" class="list">
      <div v-for="f in findings" :key="f.id" class="item">
        <div class="item-body">
          <div class="item-title">{{ findingTitle(f) }}</div>
          <div v-if="findingDetail(f)" class="item-detail">{{ findingDetail(f) }}</div>
        </div>
        <div class="item-actions">
          <button class="btn primary" @click="repairOne(f)">{{ repairLabel(f.kind) }}</button>
        </div>
      </div>
    </section>

    <section v-if="conflicts.length">
      <h3>{{ t('sync.conflictTitle', { count: conflicts.length }) }}</h3>
      <div v-for="c in conflicts" :key="c.recordId" class="item">
        <div class="item-body">
          <div class="item-title">{{ t('sync.find.conflictItem', { type: typeName(c.type) }) }}</div>
          <div class="item-detail">{{ t('sync.find.conflictDetail') }}</div>
        </div>
        <div class="item-actions">
          <button class="btn" @click="resolveConflict(c.recordId, 'local')">{{ t('sync.conflict.keepLocal') }}</button>
          <button class="btn" @click="resolveConflict(c.recordId, 'merge')">{{ t('sync.conflict.merge') }}</button>
          <button class="btn" @click="resolveConflict(c.recordId, 'remote')">{{ t('sync.conflict.useRemote') }}</button>
        </div>
      </div>
    </section>

    <footer v-if="findings.length" class="doctor-foot">
      <button class="btn primary" @click="repairAll">{{ t('sync.doctorRepairAll') }}</button>
    </footer>
    <p v-if="lastCheckAt" class="last-check">{{ t('sync.doctorLastCheck', { time: formatCheckTime(lastCheckAt) }) }}</p>
  </div>
</template>

<style scoped>
.doctor { padding: 12px 16px; max-width: 640px; margin: 0 auto; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.doctor-head { display: flex; align-items: center; justify-content: space-between; }
.doctor-head h2 { font-size: 15px; font-weight: 600; margin: 0; }
.state { padding: 8px 10px; border-radius: 4px; margin: 8px 0; }
.state.ok { color: var(--vscode-testing-iconPassed, #73c991); }
.state.warn { color: var(--vscode-charts-yellow, #cca700); }
.state.locked { color: var(--vscode-editorWarning-foreground, #cca700); }
.result { color: var(--vscode-charts-green, #89d185); margin: 8px 0; }
h3 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
.list .item, section .item { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; margin: 6px 0; }
.item-body { min-width: 0; }
.item-title { font-size: 13px; }
.item-detail { font-size: 12px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; word-break: break-all; }
.item-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.btn { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.btn:hover { filter: brightness(1.15); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.btn:disabled { opacity: 0.6; cursor: default; }
.doctor-foot { margin-top: 10px; }
.last-check { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
</style>
