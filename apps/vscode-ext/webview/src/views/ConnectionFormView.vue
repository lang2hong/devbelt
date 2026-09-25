<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const editingId = ref('');
const groups = ref<{ id: string; name: string; depth?: number }[]>([]);

function indentGroup(g: { name: string; depth?: number }): string {
  return '\u00a0\u00a0'.repeat(g.depth || 0) + g.name;
}
const status = ref('');
const statusOk = ref(true);

const defaultForm = {
  dbType: 'MYSQL',
  name: '',
  groupId: '',
  host: 'localhost',
  port: '3306',
  user: 'root',
  password: '',
  database: '',
  dbPath: '',
  schema: '',
  timezone: '',
  sqliteCommand: '',
  environment: 'development',
  readOnly: false,
  useConnectionString: false,
  connectionUrl: '',
  useSSL: false,
  caPath: '',
  clientCertPath: '',
  clientKeyPath: '',
  connectTimeout: '5000',
  requestTimeout: '30000',
  socketPath: '',
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshPassword: '',
  sshPrivateKeyPath: '',
  sshPassphrase: '',
  clearPassword: false,
  clearSshPassword: false,
  clearSshPassphrase: false,
  // Redis（P7）
  redisMode: 'standalone',
  redisDb: '',
  clusterNodes: '',
  sentinelNodes: '',
  sentinelName: '',
  sentinelPassword: '',
  keySeparator: ':',
  color: '',
  clearSentinelPassword: false,
};

const SECRET_KEYS = ['password', 'sshPassword', 'sshPassphrase', 'sentinelPassword'] as const;
type SecretKey = typeof SECRET_KEYS[number];

function clearFlagKey(key: SecretKey): string {
  return `clear${key[0].toUpperCase()}${key.slice(1)}`;
}
const form = reactive({ ...defaultForm });

const showPassword = ref(false);
const showSshPassword = ref(false);
const showSshPassphrase = ref(false);
const showSentinelPassword = ref(false);

const isSqlite = computed(() => form.dbType === 'SQLITE');
const isPg = computed(() => form.dbType === 'PG');
const isRedis = computed(() => form.dbType === 'REDIS');


function syncType(): void {
  if (form.dbType === 'PG') form.port = '5432';
  else if (form.dbType === 'MYSQL') form.port = '3306';
  else if (form.dbType === 'REDIS') form.port = '6379';
  if (isSqlite.value) form.host = '';
}

function collect(): Record<string, unknown> {
  const result: Record<string, unknown> = { id: editingId.value };
  for (const key of Object.keys(form)) {
    if (key.startsWith('clear')) continue;
    result[key] = (form as any)[key];
  }
  // 敏感字段：编辑时留空 = 保留已存密钥（不发送），只有点「清除」才发空串触发删除。
  for (const key of SECRET_KEYS) {
    if ((form as any)[clearFlagKey(key)]) result[key] = '';
    else if (result[key] === '') delete result[key];
  }
  return result;
}

/** 标记清除某个已保存密钥（发送空串；否则留空将保留原值）。 */
function clearSecret(key: SecretKey): void {
  (form as any)[key] = '';
  (form as any)[clearFlagKey(key)] = true;
}

function prefill(c: Record<string, any>): void {
  editingId.value = c.id || '';
  for (const key of Object.keys(form)) {
    const val = c[key];
    const defVal = (defaultForm as any)[key];
    if (typeof defVal === 'boolean') {
      (form as any)[key] = !!val;
    } else if (val !== undefined && val !== null) {
      (form as any)[key] = val;
    } else {
      (form as any)[key] = defVal;
    }
  }
  syncType();
}

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      groups.value = Array.isArray(msg.groups) ? msg.groups : [];
    } else if (msg.type === 'prefill' && msg.conn) {
      prefill(msg.conn);
    } else if (msg.type === 'reset') {
      Object.assign(form, defaultForm);
      editingId.value = '';
      syncType();
    } else if (msg.type === 'presetGroup' && msg.groupId) {
      form.groupId = msg.groupId;
    } else if (msg.type === 'testResult') {
      status.value = msg.message || '';
      statusOk.value = !!msg.ok;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function test(): void {
  status.value = t('wv.form.testing');
  statusOk.value = true;
  post({ type: 'test', payload: collect() });
}

function save(): void {
  post({ type: 'save', payload: collect() });
}
</script>

<template>
  <div class="container">
    <h2>{{ editingId ? t('wv.form.editTitle') : t('wv.form.title') }}</h2>

    <div class="field">
      <label>{{ t('wv.form.dbType') }}</label>
      <select v-model="form.dbType" @change="syncType">
        <option value="MYSQL">MySQL</option>
        <option value="PG">PostgreSQL</option>
        <option value="SQLITE">SQLite</option>
        <option value="REDIS">Redis</option>
      </select>
    </div>

    <div class="row">
      <div class="field">
        <label>{{ t('wv.form.name') }}</label>
        <input v-model="form.name" :placeholder="t('wv.form.namePlaceholder')">
      </div>
      <div class="field">
        <label>{{ t('wv.form.group') }}</label>
        <select v-model="form.groupId">
          <option value="">{{ t('wv.form.noGroup') }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ indentGroup(g) }}</option>
        </select>
      </div>
    </div>

    <div v-if="!isSqlite" class="row">
      <div class="field">
        <label>{{ t('wv.form.host') }}</label>
        <input v-model="form.host">
      </div>
      <div class="field">
        <label>{{ t('wv.form.port') }}</label>
        <input v-model="form.port">
      </div>
    </div>

    <div v-if="!isSqlite" class="row">
      <div class="field">
        <label>{{ t('wv.form.user') }}</label>
        <input v-model="form.user">
      </div>
      <div class="field">
        <label>{{ t('wv.form.password') }}</label>
        <div class="pw">
          <input :type="showPassword ? 'text' : 'password'" v-model="form.password">
          <button type="button" class="toggle" @click="showPassword = !showPassword">{{ showPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
          <button v-if="editingId" type="button" class="toggle" @click="clearSecret('password')">{{ t('wv.form.clear') }}</button>
        </div>
        <p v-if="editingId && form.clearPassword" class="hint">{{ t('wv.form.willClear') }}</p>
        <p v-else-if="editingId && !form.password" class="hint">{{ t('wv.form.secretSaved') }}</p>
      </div>
    </div>

    <div v-if="!isSqlite && !isRedis" class="row">
      <div class="field">
        <label>{{ t('wv.form.database') }}</label>
        <input v-model="form.database" :placeholder="t('wv.form.databasePlaceholder')">
      </div>
      <div v-if="isPg" class="field">
        <label>{{ t('wv.form.schema') }}</label>
        <input v-model="form.schema" placeholder="public">
      </div>
    </div>

    <template v-if="isRedis">
      <div class="row">
        <div class="field">
          <label>{{ t('wv.form.redisMode') }}</label>
          <select v-model="form.redisMode">
            <option value="standalone">standalone</option>
            <option value="cluster">cluster</option>
            <option value="sentinel">sentinel</option>
          </select>
        </div>
        <div v-if="form.redisMode !== 'cluster'" class="field"><label>{{ t('wv.form.redisDb') }}</label><input v-model="form.redisDb" type="number"></div>
      </div>
      <div v-if="form.redisMode === 'cluster'" class="field">
        <label>{{ t('wv.form.clusterNodes') }}</label>
        <input v-model="form.clusterNodes" :placeholder="t('wv.form.clusterNodesHint')">
      </div>
      <template v-if="form.redisMode === 'sentinel'">
        <div class="field">
          <label>{{ t('wv.form.sentinelNodes') }}</label>
          <input v-model="form.sentinelNodes" :placeholder="t('wv.form.sentinelNodesHint')">
        </div>
        <div class="row">
          <div class="field"><label>{{ t('wv.form.sentinelName') }}</label><input v-model="form.sentinelName"></div>
          <div class="field">
            <label>{{ t('wv.form.sentinelPassword') }}</label>
            <div class="pw">
              <input :type="showSentinelPassword ? 'text' : 'password'" v-model="form.sentinelPassword">
              <button type="button" class="toggle" @click="showSentinelPassword = !showSentinelPassword">{{ showSentinelPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
              <button v-if="editingId" type="button" class="toggle" @click="clearSecret('sentinelPassword')">{{ t('wv.form.clear') }}</button>
            </div>
            <p v-if="editingId && form.clearSentinelPassword" class="hint">{{ t('wv.form.willClear') }}</p>
            <p v-else-if="editingId && !form.sentinelPassword" class="hint">{{ t('wv.form.secretSaved') }}</p>
          </div>
        </div>
      </template>
      <div class="row">
        <div class="field"><label>{{ t('wv.form.keySeparator') }}</label><input v-model="form.keySeparator" maxlength="4"></div>
        <div class="field"><label>{{ t('wv.form.color') }}</label><input v-model="form.color" :placeholder="t('wv.form.colorHint')"></div>
      </div>
    </template>

    <div v-if="isSqlite" class="field">
      <label>{{ t('wv.form.sqlitePath') }}</label>
      <input v-model="form.dbPath" placeholder="/path/to/db.sqlite">
    </div>

    <details class="ssh-section" v-if="!isSqlite">
      <summary>{{ t('wv.form.ssh') }}</summary>
      <div class="field"><label>{{ t('wv.form.sshHost') }}</label><input v-model="form.sshHost"></div>
      <div class="field"><label>{{ t('wv.form.sshPort') }}</label><input v-model="form.sshPort" type="number"></div>
      <div class="field"><label>{{ t('wv.form.sshUser') }}</label><input v-model="form.sshUser"></div>
      <div class="field"><label>{{ t('wv.form.sshPass') }}</label>
        <div class="pw"><input :type="showSshPassword ? 'text' : 'password'" v-model="form.sshPassword"><button type="button" class="toggle" @click="showSshPassword = !showSshPassword">{{ showSshPassword ? t('wv.form.hide') : t('wv.form.show') }}</button><button v-if="editingId" type="button" class="toggle" @click="clearSecret('sshPassword')">{{ t('wv.form.clear') }}</button></div>
        <p v-if="editingId && form.clearSshPassword" class="hint">{{ t('wv.form.willClear') }}</p>
        <p v-else-if="editingId && !form.sshPassword" class="hint">{{ t('wv.form.secretSaved') }}</p>
      </div>
      <div class="field"><label>{{ t('wv.form.sshKey') }}</label><input v-model="form.sshPrivateKeyPath"></div>
      <div class="field"><label>{{ t('wv.form.sshPhrase') }}</label>
        <div class="pw"><input :type="showSshPassphrase ? 'text' : 'password'" v-model="form.sshPassphrase"><button type="button" class="toggle" @click="showSshPassphrase = !showSshPassphrase">{{ showSshPassphrase ? t('wv.form.hide') : t('wv.form.show') }}</button><button v-if="editingId" type="button" class="toggle" @click="clearSecret('sshPassphrase')">{{ t('wv.form.clear') }}</button></div>
        <p v-if="editingId && form.clearSshPassphrase" class="hint">{{ t('wv.form.willClear') }}</p>
        <p v-else-if="editingId && !form.sshPassphrase" class="hint">{{ t('wv.form.secretSaved') }}</p>
      </div>
    </details>

    <details class="ssh-section">
      <summary>{{ t('wv.form.advanced') }}</summary>
      <div class="row">
        <div class="field"><label>{{ t('wv.form.env') }}</label>
          <select v-model="form.environment">
            <option value="development">{{ t('wv.form.envDev') }}</option>
            <option value="test">{{ t('wv.form.envTest') }}</option>
            <option value="staging">{{ t('wv.form.envStaging') }}</option>
            <option value="production">{{ t('wv.form.envProd') }}</option>
          </select>
        </div>
        <div class="field"><label><input v-model="form.readOnly" type="checkbox" style="width:auto"> {{ t('wv.form.readOnly') }}</label></div>
      </div>
      <div v-if="!isRedis" class="field"><label><input v-model="form.useConnectionString" type="checkbox" style="width:auto"> {{ t('wv.form.useConnUrl') }}</label><input v-model="form.connectionUrl" placeholder="mysql://user:password@host:3306/database"></div>
      <div class="field"><label><input v-model="form.useSSL" type="checkbox" style="width:auto"> {{ t('wv.form.useSsl') }}</label></div>
      <div class="field"><label>{{ t('wv.form.caCert') }}</label><input v-model="form.caPath"></div>
      <div class="row">
        <div class="field"><label>{{ t('wv.form.clientCert') }}</label><input v-model="form.clientCertPath"></div>
        <div class="field"><label>{{ t('wv.form.clientKey') }}</label><input v-model="form.clientKeyPath"></div>
      </div>
      <div class="row">
        <div class="field"><label>{{ t('wv.form.connTimeout') }}</label><input v-model="form.connectTimeout" type="number"></div>
        <div class="field"><label>{{ t('wv.form.reqTimeout') }}</label><input v-model="form.requestTimeout" type="number"></div>
      </div>
      <div class="field"><label>{{ t('wv.form.socketPath') }}</label><input v-model="form.socketPath"></div>
    </details>

    <div class="actions">
      <button id="btnTest" class="secondary" @click="test">{{ t('wv.form.test') }}</button>
      <button id="btnSave" @click="save">{{ t('wv.form.save') }}</button>
    </div>
    <div id="status" :class="statusOk ? 'ok' : 'err'">{{ status }}</div>
  </div>
</template>

<style scoped>
.container {
  max-width: 480px; margin: 40px auto; padding: 24px 28px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
  border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
.field { margin-bottom: 14px; }
label { display: block; font-size: 12px; margin-bottom: 5px; color: var(--vscode-descriptionForeground, #808080); font-weight: 500; }
input, select {
  width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 13px;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px;
}
input:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder, #007fd4); }
.row { display: flex; gap: 12px; }
.row .field { flex: 1; }
.pw { display: flex; gap: 6px; align-items: center; }
.hint { margin: 4px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground, #808080); }
.pw input { flex: 1; }
.pw .toggle { flex: 0 0 auto; padding: 7px 10px; cursor: pointer; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); font-size: 12px; }
.pw .toggle:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.actions { margin-top: 24px; display: flex; gap: 10px; }
button {
  flex: 1; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
  font-size: 13px; font-weight: 500;
  background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff);
}
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
#status { margin-top: 14px; font-size: 12px; min-height: 18px; }
#status.ok { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
#status.err { color: var(--vscode-errorForeground, #f48771); }
</style>
