<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const tab = ref<'cols' | 'idx' | 'ddl'>('cols');
const columns = ref<any[]>([]);
const indexes = ref<any[]>([]);
const ddl = ref('');
const error = ref('');

const canReorder = ref(false);
const dbType = ref('');

/**
 * 表单校验提示。
 *
 * 与 `error` 分开：`error` 走 `v-if/v-else`，写进去会把整个表单替换掉，
 * 用户就看不到自己填了一半的内容了。这里是行内横幅，表单保持可见可改。
 * 之前这些校验分支是静默 `return`，点 Add 完全没反应。
 */
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function notify(msg: string): void {
  notice.value = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 4000);
}

function clearNotice(): void {
  notice.value = '';
  clearTimeout(noticeTimer);
}
/** 列类型候选，由扩展端按方言注入（MySQL/PG/SQLite 各不相同）。 */
const columnTypes = ref<string[]>([]);

/**
 * 类型下拉状态。
 *
 * 不用原生 `<input list>`：datalist 会按输入框当前值做前缀过滤，编辑已有列时
 * 值已是 `varchar(50)`，没有候选以它开头，下拉恒为空。这里自建浮层，
 * 有值时也能看到完整候选，并额外提供子串匹配。
 */
const typePicker = ref<'edit' | 'new' | null>(null);
const typeFilter = ref('');

const filteredTypes = computed(() => {
  const kw = typeFilter.value.trim().toLowerCase();
  if (!kw) return columnTypes.value;
  return columnTypes.value.filter((t) => t.toLowerCase().includes(kw));
});

function openTypePicker(which: 'edit' | 'new') {
  typePicker.value = which;
  typeFilter.value = '';
}

function closeTypePicker() {
  typePicker.value = null;
  typeFilter.value = '';
}

function chooseType(t: string) {
  if (typePicker.value === 'edit' && editingCol.value) editingCol.value.type = t;
  else if (typePicker.value === 'new') newRow.value.type = t;
  closeTypePicker();
}

/** 新列的建议类型：取方言候选里第一个字符串类型，无候选时留空。 */
const defaultType = computed(() => {
  const preferred = columnTypes.value.find((t) => /^(VARCHAR|CHARACTER VARYING|TEXT)/i.test(t));
  return preferred ?? columnTypes.value[0] ?? '';
});

// 列编辑/新增状态
interface ColForm { name: string; type: string; notNull: boolean; defaultVal: string; comment: string; }
const editingCol = ref<ColForm | null>(null);
const editingName = ref('');
const newRow = ref<ColForm>({ name: '', type: '', notNull: false, defaultVal: '', comment: '' });
const confirmDrop = ref<{ name: string } | null>(null);

// 索引编辑/新增状态
interface IdxForm { oldName?: string; name: string; cols: Record<string, boolean>; unique: boolean; }
const showIdxForm = ref(false);
const idxForm = ref<IdxForm>({ name: '', cols: {}, unique: false });
const confirmDropIdx = ref<{ name: string } | null>(null);

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      dbType.value = msg.dbType;
      canReorder.value = msg.dbType === 'MYSQL';
      columnTypes.value = Array.isArray(msg.columnTypes) ? msg.columnTypes : [];
    } else if (msg.type === 'data') {
      columns.value = msg.columns || [];
      indexes.value = msg.indexes || [];
      ddl.value = msg.ddl || t('wv.design.noDdl');
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => {
  cleanup?.();
  clearTimeout(noticeTimer);
});

function startEdit(col: any) {
  editingName.value = col.name;
  editingCol.value = {
    name: col.name,
    type: col.type || col.simpleType || defaultType.value,
    notNull: !!col.isNotNull || col.nullable === 'NO',
    defaultVal: col.defaultValue ?? '',
    comment: col.comment ?? '',
  };
}

function cancelEdit() {
  editingCol.value = null;
  editingName.value = '';
}

function saveEdit() {
  const f = editingCol.value;
  if (!f) return;
  if (!f.type.trim()) return notify(t('wv.design.columnTypeRequired'));
  post({ type: 'modifyColumn', column: f.name, definition: buildDef(f) });
  editingCol.value = null;
  editingName.value = '';
  clearNotice();
}

function saveAdd() {
  const f = newRow.value;
  const type = (f.type || defaultType.value).trim();
  if (!f.name.trim()) return notify(t('wv.design.columnNameRequired'));
  if (!type) return notify(t('wv.design.columnTypeRequired'));
  post({ type: 'addColumn', column: f.name.trim(), definition: buildDef({ ...f, type }) });
  newRow.value = { name: '', type: '', notNull: false, defaultVal: '', comment: '' };
  clearNotice();
}

function moveColumn(col: any, dir: 'up' | 'down') {
  if (!canReorder.value) return;
  const idx = columns.value.findIndex((c: any) => c.name === col.name);
  if (idx < 0) return;
  const len = columns.value.length;
  if (dir === 'up' && idx === 0) return;
  if (dir === 'down' && idx >= len - 1) return;
  const afterColumn = dir === 'up'
    ? (idx - 1 <= 0 ? null : columns.value[idx - 2].name)
    : columns.value[idx + 1].name;
  post({ type: 'reorderColumn', column: col.name, afterColumn });
}

function dropCol(col: any) {
  confirmDrop.value = { name: col.name };
}
function confirmDropCol() {
  if (!confirmDrop.value) return;
  post({ type: 'dropColumn', column: confirmDrop.value.name });
  confirmDrop.value = null;
}

function buildDef(f: ColForm): string {
  let s = f.type.trim();
  s += f.notNull ? ' NOT NULL' : ' NULL';
  const dv = f.defaultVal.trim();
  if (dv !== '') {
    const raw = /^-?\d+(\.\d+)?$/.test(dv) || /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL)$/i.test(dv);
    s += ` DEFAULT ${raw ? dv : `'${dv.replace(/'/g, "''")}'`}`;
  }
  // 列内联 COMMENT 是 MySQL 语法；PG/SQLite 的 ALTER TABLE 不接受，附加会导致语法错误。
  if (f.comment.trim() && dbType.value === 'MYSQL') {
    s += ` COMMENT '${f.comment.trim().replace(/'/g, "''")}'`;
  }
  return s;
}

// ── 索引 ──
function startAddIdx() {
  showIdxForm.value = true;
  const cols: Record<string, boolean> = {};
  for (const c of columns.value) cols[c.name] = false;
  idxForm.value = { name: '', cols, unique: false };
}

function startEditIdx(i: any) {
  showIdxForm.value = true;
  const cols: Record<string, boolean> = {};
  for (const c of columns.value) cols[c.name] = (i.columns || []).includes(c.name);
  idxForm.value = { oldName: i.name, name: i.name, cols, unique: !!i.isUnique };
}

function cancelIdxForm() {
  showIdxForm.value = false;
  idxForm.value = { name: '', cols: {}, unique: false };
}

function saveIdxForm() {
  const f = idxForm.value;
  const name = f.name.trim();
  const cols = Object.keys(f.cols).filter((c) => f.cols[c]);
  if (!name) return notify(t('wv.design.indexNameRequired'));
  if (!cols.length) return notify(t('wv.design.indexColumnsRequired'));
  clearNotice();
  if (f.oldName) {
    post({ type: 'editIndex', oldName: f.oldName, name, columns: cols, isUnique: f.unique });
  } else {
    post({ type: 'addIndex', name, columns: cols, isUnique: f.unique });
  }
  showIdxForm.value = false;
}

function dropIdx(i: any) {
  confirmDropIdx.value = { name: i.name };
}
function confirmDropIdxHandler() {
  if (!confirmDropIdx.value) return;
  post({ type: 'dropIndex', name: confirmDropIdx.value.name });
  confirmDropIdx.value = null;
}

const idxSelectedCols = computed(() => Object.keys(idxForm.value.cols).filter((c) => idxForm.value.cols[c]));

/**
 * 把驱动返回的"布尔"值归一化。
 *
 * MySQL 驱动会把 `information_schema` 的布尔表达式字符串化为 `"0"`/`"1"`，
 * 而 JS 中 `!!"0"` 为真——这曾让每个索引的编辑/删除按钮都被禁用。
 * db-core 侧已归一，这里对直接透传的字段再兜一层。
 */
function truthy(v: unknown): boolean {
  if (typeof v === 'string') return !['0', '', 'false', 'no'].includes(v.trim().toLowerCase());
  return !!v;
}
</script>

<template>
  <div class="app">
    <div class="tabs">
      <button :class="{ active: tab === 'cols' }" @click="tab = 'cols'">{{ t('wv.design.tabColumns') }}</button>
      <button :class="{ active: tab === 'idx' }" @click="tab = 'idx'">{{ t('wv.design.tabIndexes') }}</button>
      <button :class="{ active: tab === 'ddl' }" @click="tab = 'ddl'">{{ t('wv.design.tabDdl') }}</button>
    </div>
    <div class="error" v-if="error">{{ error }}</div>
    <div class="content" v-else>
      <div v-if="notice" class="notice" role="alert">
        <span>{{ notice }}</span>
        <button class="notice-close" :title="t('wv.common.dismiss')" @click="clearNotice">✕</button>
      </div>
      <!-- Columns -->
      <div v-if="tab === 'cols'">
        <table class="grid">
          <thead>
            <tr>
              <th class="c-name">{{ t('wv.common.name') }}</th>
              <th class="c-type">{{ t('wv.common.type') }}</th>
              <th class="c-chk">{{ t('wv.design.notNull') }}</th>
              <th class="c-def">{{ t('wv.design.default') }}</th>
              <th class="c-cmt">{{ t('wv.design.comment') }}</th>
              <th class="c-act">{{ t('wv.common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, idx) in columns" :key="c.name">
              <template v-if="editingName === c.name && editingCol">
                <td class="mono">{{ c.name }}</td>
                <td>
                  <div class="type-cell">
                    <input v-model="editingCol.type" class="input" :placeholder="defaultType" />
                    <button class="btn sm type-toggle" :disabled="!columnTypes.length"
                      :title="t('wv.design.pickType')" @click="openTypePicker('edit')">▾</button>
                  </div>
                </td>
                <td><input type="checkbox" v-model="editingCol.notNull" /></td>
                <td><input v-model="editingCol.defaultVal" class="input" :placeholder="t('wv.common.null')" /></td>
                <td><input v-model="editingCol.comment" class="input" /></td>
                <td>
                  <button class="btn primary" @click="saveEdit">{{ t('wv.common.save') }}</button>
                  <button class="btn" @click="cancelEdit">{{ t('wv.common.cancel') }}</button>
                </td>
              </template>
              <template v-else>
                <td class="mono">{{ c.name }}</td>
                <td class="mono">{{ c.type || c.simpleType }}</td>
                <td>{{ c.isNotNull || c.nullable === 'NO' ? 'YES' : 'NO' }}</td>
                <td class="mono">{{ c.defaultValue ?? '' }}</td>
                <td>{{ c.comment ?? '' }}</td>
                <td>
                  <button v-if="canReorder" class="btn sm" :disabled="idx === 0" @click="moveColumn(c, 'up')" :title="t('wv.design.moveUp')">▲</button>
                  <button v-if="canReorder" class="btn sm" :disabled="idx === columns.length - 1" @click="moveColumn(c, 'down')" :title="t('wv.design.moveDown')">▼</button>
                  <button class="btn" @click="startEdit(c)">{{ t('wv.common.edit') }}</button>
                  <button class="btn danger" @click="dropCol(c)">{{ t('wv.common.del') }}</button>
                </td>
              </template>
            </tr>
            <tr class="new-row">
              <td><input v-model="newRow.name" class="input" :placeholder="t('wv.design.newColumn')" /></td>
              <td>
                <div class="type-cell">
                  <input v-model="newRow.type" class="input" :placeholder="defaultType" />
                  <button class="btn sm type-toggle" :disabled="!columnTypes.length"
                    :title="t('wv.design.pickType')" @click="openTypePicker('new')">▾</button>
                </div>
              </td>
              <td><input type="checkbox" v-model="newRow.notNull" /></td>
              <td><input v-model="newRow.defaultVal" class="input" :placeholder="t('wv.common.null')" /></td>
              <td><input v-model="newRow.comment" class="input" /></td>
              <td><button class="btn primary" @click="saveAdd">{{ t('wv.design.addColumn') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- Indexes -->
      <div v-else-if="tab === 'idx'">
        <div class="toolbar">
          <button class="btn" @click="startAddIdx">{{ t('wv.design.addIndex') }}</button>
        </div>
        <table class="grid">
          <thead><tr><th class="c-name">{{ t('wv.common.name') }}</th><th>{{ t('wv.design.tabColumns') }}</th><th class="c-chk">{{ t('wv.design.unique') }}</th><th class="c-chk">{{ t('wv.design.primary') }}</th><th class="c-act">{{ t('wv.common.actions') }}</th></tr></thead>
          <tbody>
            <tr v-for="i in indexes" :key="i.name">
              <td class="mono">{{ i.name }}</td>
              <td class="mono">{{ (i.columns || []).join(', ') }}</td>
              <td>{{ truthy(i.isUnique) ? 'YES' : 'NO' }}</td>
              <td>{{ truthy(i.isPrimary) ? 'YES' : 'NO' }}</td>
                <td>
                  <button class="btn" @click="startEditIdx(i)">{{ t('wv.common.edit') }}</button>
                  <button class="btn danger" :disabled="truthy(i.isPrimary)"
                    :title="truthy(i.isPrimary) ? t('wv.design.primaryCannotDrop') : t('wv.design.dropIndexTitle')"
                    @click="dropIdx(i)">{{ t('wv.common.del') }}</button>
                </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- DDL -->
      <pre v-else>{{ ddl }}</pre>
    </div>
    <!-- 类型选择浮层：候选来自方言，有值时也展示全量（原生 datalist 会按前缀过滤而空掉） -->
    <div v-if="typePicker" class="modal-mask" @click.self="closeTypePicker">
      <div class="modal type-modal">
        <div class="modal-title">{{ t('wv.common.type') }} · {{ dbType }}</div>
        <input v-model="typeFilter" class="input" :placeholder="t('wv.design.filterTypes')" autofocus />
        <div class="type-list">
          <button v-for="t in filteredTypes" :key="t" class="type-item mono" @click="chooseType(t)">{{ t }}</button>
          <div v-if="!filteredTypes.length" class="type-empty">{{ t('wv.design.noMatchingType') }}</div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="closeTypePicker">{{ t('wv.common.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 索引编辑/新增弹窗 -->
    <div v-if="showIdxForm" class="modal-mask" @click.self="cancelIdxForm">
      <div class="modal idx-modal">
        <div class="modal-title">{{ idxForm.oldName ? t('wv.common.edit') : t('wv.design.addIndex') }}</div>
        <div class="form-row">
          <label>{{ t('wv.design.indexName') }}</label>
          <input v-model="idxForm.name" class="input" :placeholder="t('wv.design.indexNamePlaceholder')" />
        </div>
        <div class="form-row">
          <label class="chk"><input type="checkbox" v-model="idxForm.unique" /> Unique</label>
        </div>
        <div class="form-row col-pick">
          <label>Columns ({{ idxSelectedCols.length }})</label>
          <div class="col-list">
            <label v-for="c in columns" :key="c.name" class="chk col-item">
              <input type="checkbox" v-model="idxForm.cols[c.name]" /> {{ c.name }}
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="cancelIdxForm">{{ t('wv.common.cancel') }}</button>
          <button class="btn primary" @click="saveIdxForm">{{ idxForm.oldName ? 'Save' : 'Add' }}</button>
        </div>
      </div>
    </div>

    <div v-if="confirmDrop" class="modal-mask" @click.self="confirmDrop = null">
      <div class="modal">
        <div class="modal-title">{{ t('wv.design.deleteColumn') }}</div>
        <div class="modal-body">{{ t('wv.design.confirmDropColumn', { name: confirmDrop.name }) }}</div>
        <div class="modal-actions">
          <button class="btn" @click="confirmDrop = null">{{ t('wv.common.cancel') }}</button>
          <button class="btn danger" @click="confirmDropCol">{{ t('wv.common.delete') }}</button>
        </div>
      </div>
    </div>
    <div v-if="confirmDropIdx" class="modal-mask" @click.self="confirmDropIdx = null">
      <div class="modal">
        <div class="modal-title">{{ t('wv.design.deleteIndex') }}</div>
        <div class="modal-body">{{ t('wv.design.confirmDropIndex', { name: confirmDropIdx.name }) }}</div>
        <div class="modal-actions">
          <button class="btn" @click="confirmDropIdx = null">{{ t('wv.common.cancel') }}</button>
          <button class="btn danger" @click="confirmDropIdxHandler">{{ t('wv.common.delete') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); }
.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.tabs button { padding: 6px 16px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground, #cccccc); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder, #007fd4); color: var(--vscode-textLink-foreground, #4daafc); }
.content { flex: 1; overflow: auto; padding: 8px; }
.toolbar { margin-bottom: 8px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.sm { padding: 2px 6px; }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
.btn.danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
.input { font-size: 12px; padding: 3px 6px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; width: 100%; box-sizing: border-box; }
.grid { border-collapse: collapse; font-size: 13px; width: 100%; table-layout: fixed; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 8px; text-align: left; overflow: hidden; text-overflow: ellipsis; }
th { background: var(--vscode-editor-background, #1e1e1e); position: sticky; top: 0; z-index: 1; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
.c-name { width: 20%; }
.c-type { width: 22%; }
.c-chk { width: 8%; text-align: center; }
.c-def { width: 15%; }
.c-cmt { width: 20%; }
.c-act { width: 15%; white-space: nowrap; }
.new-row { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 4px; padding: 16px; min-width: 320px; }
.modal-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
.modal-body { font-size: 12px; color: var(--vscode-foreground, #cccccc); margin-bottom: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.idx-modal { min-width: 360px; }
.type-cell { display: flex; gap: 4px; align-items: center; }
.type-cell .input { flex: 1; min-width: 0; }
.type-toggle { flex: 0 0 auto; }
.type-modal { min-width: 320px; max-width: 420px; }
.type-list { margin-top: 8px; max-height: 260px; overflow-y: auto; display: flex; flex-direction: column;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; }
.type-item { text-align: left; padding: 4px 8px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground, #cccccc); }
.type-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
.type-empty { padding: 8px; font-size: 12px; color: var(--vscode-descriptionForeground, #999); }
.form-row { margin-bottom: 10px; }
.form-row label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-foreground, #cccccc); }
.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.col-pick .col-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; padding: 4px; }
.col-item { display: flex; padding: 2px 4px; }
pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
.error { padding: 12px; color: var(--vscode-errorForeground, #f48771); }
.notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;
  padding: 6px 10px; font-size: 12px; border-radius: 3px;
  background: var(--vscode-inputValidation-warningBackground, #352a05);
  border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
  color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground, #cccccc)); }
.notice-close { background: transparent; border: none; cursor: pointer; padding: 0 2px;
  color: inherit; font-size: 12px; line-height: 1; }
</style>
