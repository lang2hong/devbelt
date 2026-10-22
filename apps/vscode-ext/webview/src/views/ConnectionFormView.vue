<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import {
  supportsConnectionUrl as supportsUrlType,
  validateConnectionForm,
  type ConnectionFormErrors,
  type ConnectionFormField,
} from '../utils/connectionFormValidation';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const editingId = ref('');
const groups = ref<{ id: string; name: string; depth?: number }[]>([]);
/** 宿主已剥离 connectionUrl 内嵌密码；用户未修改时省略该字段，由宿主回填原值。 */
const connectionUrlMasked = ref(false);
const prefilledConnectionUrl = ref('');

function indentGroup(g: { name: string; depth?: number }): string {
  return '\u00a0\u00a0'.repeat(g.depth || 0) + g.name;
}
const status = ref('');
const statusOk = ref(true);
const testing = ref(false);
const saving = ref(false);
const errors = ref<ConnectionFormErrors>({});

const DB_TYPES = [
  { value: 'MYSQL', label: 'MySQL', descKey: 'wv.form.typeMysqlDesc' },
  { value: 'PG', label: 'PostgreSQL', descKey: 'wv.form.typePgDesc' },
  { value: 'SQLITE', label: 'SQLite', descKey: 'wv.form.typeSqliteDesc' },
  { value: 'REDIS', label: 'Redis', descKey: 'wv.form.typeRedisDesc' },
  { value: 'ELASTICSEARCH', label: 'Elasticsearch', descKey: 'wv.form.typeEsDesc' },
] as const;

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
  requestTimeout: '',
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
  // Elasticsearch（P8 S2）
  esProtocol: 'http',
  esPathPrefix: '',
  esAuth: 'basic',
  esUser: 'elastic',
  esPassword: '',
  esApiKey: '',
  clearEsPassword: false,
  clearEsApiKey: false,
};

const SECRET_KEYS = ['password', 'sshPassword', 'sshPassphrase', 'sentinelPassword', 'esPassword', 'esApiKey'] as const;
type SecretKey = typeof SECRET_KEYS[number];

function clearFlagKey(key: SecretKey): string {
  return `clear${key[0].toUpperCase()}${key.slice(1)}`;
}
const form = reactive({ ...defaultForm });

const showPassword = ref(false);
const showSshPassword = ref(false);
const showSshPassphrase = ref(false);
const showSentinelPassword = ref(false);
const showEsPassword = ref(false);
const showEsApiKey = ref(false);

const isSqlite = computed(() => form.dbType === 'SQLITE');
const isPg = computed(() => form.dbType === 'PG');
const isRedis = computed(() => form.dbType === 'REDIS');
const isEs = computed(() => form.dbType === 'ELASTICSEARCH');
/** MySQL / PostgreSQL：关系型连接。 */
const isSql = computed(() => !isSqlite.value && !isRedis.value && !isEs.value);
const canUseConnectionUrl = computed(() => supportsUrlType(form.dbType));
const showDatabase = computed(() => isSql.value && !form.useConnectionString);
const showSocket = computed(() => isSql.value && !form.useConnectionString);
const showConnectTimeout = computed(() => !isEs.value);
const urlMode = computed(() => canUseConnectionUrl.value && form.useConnectionString);
const showSsh = computed(() => !isSqlite.value);
const showAdvanced = computed(() => !isSqlite.value);
const busy = computed(() => testing.value || saving.value);

const urlPlaceholder = computed(() =>
  form.dbType === 'PG'
    ? 'postgres://user:password@host:5432/database'
    : 'mysql://user:password@host:3306/database',
);

/** 默认用户名：Redis/ES 为空；SQL 为 root。 */
function defaultUserFor(dbType: string): string {
  return dbType === 'REDIS' || dbType === 'ELASTICSEARCH' ? '' : 'root';
}

function syncType(): void {
  if (form.dbType === 'PG') form.port = '5432';
  else if (form.dbType === 'MYSQL') form.port = '3306';
  else if (form.dbType === 'REDIS') form.port = '6379';
  else if (form.dbType === 'ELASTICSEARCH') form.port = '9200';
  if (!canUseConnectionUrl.value) form.useConnectionString = false;
  // ES 默认 Basic + elastic（官方默认管理员）；用户可切无认证/API Key。
  if (form.dbType === 'ELASTICSEARCH' && !form.esUser) form.esUser = 'elastic';
  if (isSqlite.value) form.host = '';
  // Redis/ES 默认空用户名：切换到该类时，若仍是 SQL 的默认 root，清空。
  if ((form.dbType === 'REDIS' || form.dbType === 'ELASTICSEARCH') && form.user === 'root') form.user = '';
}

function setDbType(type: string): void {
  if (form.dbType === type) return;
  form.dbType = type;
  errors.value = {};
  status.value = '';
  statusOk.value = true;
  syncType();
}

function clearError(field: ConnectionFormField): void {
  if (!errors.value[field]) return;
  const next = { ...errors.value };
  delete next[field];
  errors.value = next;
  // 字段错误清空后同步收起「请先修正高亮字段」的汇总提示；测试/保存错误也允许被下一次编辑清掉。
  if (Object.keys(next).length === 0 && !statusOk.value) status.value = '';
}

function setUrlMode(enabled: boolean): void {
  form.useConnectionString = enabled;
  clearError('connectionUrl');
}

function collect(): Record<string, unknown> {
  const result: Record<string, unknown> = { id: editingId.value };
  for (const key of Object.keys(form)) {
    if (key.startsWith('clear')) continue;
    result[key] = (form as any)[key];
  }
  // ES 认证：表单 kind 字符串 → 存储对象（username 随 basic）。
  result.esAuth = form.esAuth === 'basic'
    ? { kind: 'basic', username: form.esUser }
    : form.esAuth === 'apiKey'
      ? { kind: 'apiKey' }
      : { kind: 'none' };
  delete result.esUser;
  // 敏感字段：编辑时留空 = 保留已存密钥（不发送），只有点「清除」才发空串触发删除。
  for (const key of SECRET_KEYS) {
    if ((form as any)[clearFlagKey(key)]) result[key] = '';
    else if (result[key] === '') delete result[key];
  }
  // ES：认证方式切换后，旧方式的密钥显式清除（避免残留无用密钥）。
  if (form.esAuth !== 'basic') result.esPassword = '';
  if (form.esAuth !== 'apiKey') result.esApiKey = '';
  // connectionUrl 内嵌密码不在 webview 回显：未修改时不发送，宿主用已存值回填。
  if (connectionUrlMasked.value && result.connectionUrl === prefilledConnectionUrl.value) {
    delete result.connectionUrl;
  }
  return result;
}

/** 标记清除某个已保存密钥（发送空串；否则留空将保留原值）。 */
function clearSecret(key: SecretKey): void {
  (form as any)[key] = '';
  (form as any)[clearFlagKey(key)] = true;
}

/** 用户重新输入密钥时撤销「清除」标记，否则新输入会被空串覆盖。 */
function onSecretInput(key: SecretKey): void {
  (form as any)[clearFlagKey(key)] = false;
}

function prefill(c: Record<string, any>, urlStripped = false): void {
  errors.value = {};
  status.value = '';
  testing.value = false;
  saving.value = false;
  editingId.value = c.id || '';
  connectionUrlMasked.value = urlStripped;
  prefilledConnectionUrl.value = c.connectionUrl === undefined || c.connectionUrl === null
    ? ''
    : String(c.connectionUrl);
  for (const key of Object.keys(form)) {
    const val = c[key];
    const defVal = (defaultForm as any)[key];
    if (key === 'esAuth') {
      // 存储是对象（{kind,username?}）；表单是 kind 字符串 + esUser 独立字段。
      const kind = val?.kind;
      (form as any).esAuth = kind === 'basic' || kind === 'apiKey' ? kind : 'none';
      // 历史连接可能存了 basic+空用户名（旧版会发出 `Basic ":"` 触发误导性 401）：回填默认管理员名。
      form.esUser = val?.username && String(val.username).trim()
        ? val.username
        : ((form as any).esAuth === 'basic' ? 'elastic' : '');
    } else if (key === 'port') {
      // SavedConnection.port 是 number；表单输入统一用字符串，避免校验/比较混乱。
      (form as any)[key] = val !== undefined && val !== null ? String(val) : defVal;
    } else if (typeof defVal === 'boolean') {
      (form as any)[key] = !!val;
    } else if (key === 'user') {
      // 用户名按类型给默认：Redis/ES 空，SQL root（空值不再回退成 root）。
      (form as any)[key] = val !== undefined && val !== null && val !== '' ? val : defaultUserFor(form.dbType);
    } else if (val !== undefined && val !== null) {
      (form as any)[key] = val;
    } else {
      (form as any)[key] = defVal;
    }
  }
  if (!canUseConnectionUrl.value) form.useConnectionString = false;
  // 不在 prefill 里调用 syncType()：否则编辑已有连接时端口会被重置为默认
  // （cluster 的 7xxx 端口被改掉），且会误清真实的 Redis 用户名 "root"。
  // 默认端口/默认用户只在用户切换类型（@click）时设置。
}

function validate(): boolean {
  const next = validateConnectionForm({
    dbType: form.dbType,
    host: form.host,
    port: form.port,
    dbPath: form.dbPath,
    useConnectionString: form.useConnectionString,
    connectionUrl: form.connectionUrl,
    redisMode: form.redisMode,
    clusterNodes: form.clusterNodes,
    sentinelNodes: form.sentinelNodes,
    sentinelName: form.sentinelName,
  });
  errors.value = next;
  if (Object.keys(next).length === 0) return true;
  status.value = t('wv.form.fixErrors');
  statusOk.value = false;
  void nextTick(() => {
    document.querySelector<HTMLElement>('.field.invalid input, .field.invalid select')?.focus();
  });
  return false;
}

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      groups.value = Array.isArray(msg.groups) ? msg.groups : [];
    } else if (msg.type === 'prefill' && msg.conn) {
      prefill(msg.conn, msg.urlStripped === true);
    } else if (msg.type === 'reset') {
      Object.assign(form, defaultForm);
      editingId.value = '';
      connectionUrlMasked.value = false;
      prefilledConnectionUrl.value = '';
      errors.value = {};
      status.value = '';
      statusOk.value = true;
      testing.value = false;
      saving.value = false;
      syncType();
    } else if (msg.type === 'presetGroup' && msg.groupId) {
      form.groupId = msg.groupId;
    } else if (msg.type === 'testResult') {
      testing.value = false;
      status.value = msg.message || '';
      statusOk.value = !!msg.ok;
    } else if (msg.type === 'error') {
      testing.value = false;
      saving.value = false;
      status.value = msg.message || t('wv.form.error');
      statusOk.value = false;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function test(): void {
  if (busy.value || !validate()) return;
  testing.value = true;
  status.value = t('wv.form.testing');
  statusOk.value = true;
  post({ type: 'test', payload: collect() });
}

function save(): void {
  if (busy.value || !validate()) return;
  saving.value = true;
  status.value = t('wv.form.saving');
  statusOk.value = true;
  post({ type: 'save', payload: collect() });
}

function cancel(): void {
  if (busy.value) return;
  post({ type: 'cancel' });
}
</script>

<template>
  <div class="page">
    <form class="panel" novalidate @submit.prevent="save">
      <header class="panel-header">
        <div>
          <h2>{{ editingId ? t('wv.form.editTitle') : t('wv.form.title') }}</h2>
        </div>
      </header>

      <section class="section first">
        <h3>{{ t('wv.form.sectionConnection') }}</h3>
        <div class="type-grid">
          <button
            v-for="opt in DB_TYPES"
            :key="opt.value"
            type="button"
            class="type-card"
            :class="{ active: form.dbType === opt.value }"
            :aria-pressed="form.dbType === opt.value"
            @click="setDbType(opt.value)"
          >
            <span class="type-name">{{ opt.label }}</span>
            <span class="type-desc">{{ t(opt.descKey) }}</span>
          </button>
        </div>

        <div class="basic-grid">
          <div class="field">
            <label for="conn-name">{{ t('wv.form.name') }}</label>
            <input id="conn-name" v-model="form.name" :placeholder="t('wv.form.namePlaceholder')">
          </div>
          <div class="field">
            <label for="conn-group">{{ t('wv.form.group') }}</label>
            <select id="conn-group" v-model="form.groupId">
              <option value="">{{ t('wv.form.noGroup') }}</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ indentGroup(g) }}</option>
            </select>
          </div>
          <div class="field">
            <label for="conn-environment">{{ t('wv.form.env') }}</label>
            <select id="conn-environment" v-model="form.environment">
              <option value="development">{{ t('wv.form.envDev') }}</option>
              <option value="test">{{ t('wv.form.envTest') }}</option>
              <option value="staging">{{ t('wv.form.envStaging') }}</option>
              <option value="production">{{ t('wv.form.envProd') }}</option>
            </select>
          </div>
          <div class="field field-check">
            <label class="check" for="conn-read-only">
              <input id="conn-read-only" v-model="form.readOnly" type="checkbox">
              <span>{{ t('wv.form.readOnly') }}</span>
            </label>
          </div>
        </div>

        <template v-if="!isSqlite">
          <template v-if="isEs">
          <div class="grid">
            <div class="field">
              <label for="es-protocol">{{ t('wv.form.esProtocol') }}</label>
              <select id="es-protocol" v-model="form.esProtocol">
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
            <div class="field">
              <label for="es-prefix">{{ t('wv.form.esPathPrefix') }}</label>
              <input id="es-prefix" v-model="form.esPathPrefix" :placeholder="t('wv.form.esPathPrefixHint')">
            </div>
          </div>
        </template>

        <div v-if="canUseConnectionUrl" class="mode-switch" role="group" :aria-label="t('wv.form.sectionConnection')">
          <button type="button" :class="{ active: !form.useConnectionString }" @click="setUrlMode(false)">
            {{ t('wv.form.modeFields') }}
          </button>
          <button type="button" :class="{ active: form.useConnectionString }" @click="setUrlMode(true)">
            {{ t('wv.form.modeUrl') }}
          </button>
        </div>

        <template v-if="canUseConnectionUrl && form.useConnectionString">
          <div class="field" :class="{ invalid: errors.connectionUrl }">
            <label for="connection-url">{{ t('wv.form.connectionUrl') }}</label>
            <input
              id="connection-url"
              v-model="form.connectionUrl"
              :placeholder="urlPlaceholder"
              @input="clearError('connectionUrl')"
            >
            <p v-if="editingId && connectionUrlMasked" class="hint">{{ t('wv.form.urlSecretSaved') }}</p>
            <p v-if="errors.connectionUrl" class="field-error">{{ t(errors.connectionUrl) }}</p>
            <p v-if="form.sshHost" class="hint">{{ t('wv.form.urlSshHint') }}</p>
          </div>
        </template>

        <div v-else class="grid">
          <div class="field" :class="{ invalid: errors.host }">
            <label for="conn-host">{{ t('wv.form.host') }}</label>
            <input id="conn-host" v-model="form.host" @input="clearError('host')">
            <p v-if="errors.host" class="field-error">{{ t(errors.host) }}</p>
          </div>
          <div class="field" :class="{ invalid: errors.port }">
            <label for="conn-port">{{ t('wv.form.port') }}</label>
            <input
              id="conn-port"
              v-model="form.port"
              type="number"
              min="1"
              max="65535"
              @input="clearError('port')"
            >
            <p v-if="errors.port" class="field-error">{{ t(errors.port) }}</p>
          </div>
        </div>
        </template>

        <template v-if="!isSqlite && !urlMode">
        <template v-if="isEs">
          <div class="field">
            <label for="es-auth">{{ t('wv.form.esAuth') }}</label>
            <select id="es-auth" v-model="form.esAuth">
              <option value="none">{{ t('wv.form.esAuthNone') }}</option>
              <option value="basic">{{ t('wv.form.esAuthBasic') }}</option>
              <option value="apiKey">{{ t('wv.form.esAuthApiKey') }}</option>
            </select>
          </div>
          <div v-if="form.esAuth === 'basic'" class="grid">
            <div class="field">
              <label for="es-user">{{ t('wv.form.esUser') }}</label>
              <input id="es-user" v-model="form.esUser" placeholder="elastic">
            </div>
            <div class="field">
              <label for="es-password">{{ t('wv.form.esPassword') }}</label>
              <div class="pw">
                <input id="es-password" :type="showEsPassword ? 'text' : 'password'" v-model="form.esPassword" autocomplete="off" @input="onSecretInput('esPassword')">
                <button type="button" class="btn tiny secondary" @click="showEsPassword = !showEsPassword">{{ showEsPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
                <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('esPassword')">{{ t('wv.form.clear') }}</button>
              </div>
              <p v-if="editingId && form.clearEsPassword" class="hint">{{ t('wv.form.willClear') }}</p>
              <p v-else-if="editingId && !form.esPassword" class="hint">{{ t('wv.form.secretSaved') }}</p>
            </div>
          </div>
          <div v-if="form.esAuth === 'apiKey'" class="field">
            <label for="es-api-key">{{ t('wv.form.esApiKey') }}</label>
            <div class="pw">
              <input id="es-api-key" :type="showEsApiKey ? 'text' : 'password'" v-model="form.esApiKey" autocomplete="off" @input="onSecretInput('esApiKey')">
              <button type="button" class="btn tiny secondary" @click="showEsApiKey = !showEsApiKey">{{ showEsApiKey ? t('wv.form.hide') : t('wv.form.show') }}</button>
              <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('esApiKey')">{{ t('wv.form.clear') }}</button>
            </div>
            <p v-if="editingId && form.clearEsApiKey" class="hint">{{ t('wv.form.willClear') }}</p>
            <p v-else-if="editingId && !form.esApiKey" class="hint">{{ t('wv.form.secretSaved') }}</p>
          </div>
          <p class="hint">{{ t('wv.form.esHint') }}</p>
        </template>

        <template v-else>
          <div class="grid">
            <div class="field">
              <label for="conn-user">{{ t('wv.form.user') }}</label>
              <input id="conn-user" v-model="form.user" autocomplete="username">
            </div>
            <div class="field">
              <label for="conn-password">{{ t('wv.form.password') }}</label>
              <div class="pw">
                <input id="conn-password" :type="showPassword ? 'text' : 'password'" v-model="form.password" autocomplete="current-password" @input="onSecretInput('password')">
                <button type="button" class="btn tiny secondary" @click="showPassword = !showPassword">{{ showPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
                <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('password')">{{ t('wv.form.clear') }}</button>
              </div>
              <p v-if="editingId && form.clearPassword" class="hint">{{ t('wv.form.willClear') }}</p>
              <p v-else-if="editingId && !form.password" class="hint">{{ t('wv.form.secretSaved') }}</p>
            </div>
          </div>
        </template>
        </template>

        <template v-if="showDatabase">
        <div class="grid">
          <div class="field">
            <label for="conn-database">{{ t('wv.form.database') }}</label>
            <input id="conn-database" v-model="form.database" :placeholder="t('wv.form.databasePlaceholder')">
          </div>
          <div v-if="isPg" class="field">
            <label for="conn-schema">{{ t('wv.form.schema') }}</label>
            <input id="conn-schema" v-model="form.schema" placeholder="public">
          </div>
        </div>
        </template>

        <template v-if="isSqlite">
        <div class="field" :class="{ invalid: errors.dbPath }">
          <label for="conn-sqlite-path">{{ t('wv.form.sqlitePath') }}</label>
          <input
            id="conn-sqlite-path"
            v-model="form.dbPath"
            placeholder="/path/to/db.sqlite"
            @input="clearError('dbPath')"
          >
          <p v-if="errors.dbPath" class="field-error">{{ t(errors.dbPath) }}</p>
        </div>
        </template>

        <template v-if="isRedis">
        <div class="grid">
          <div class="field">
            <label for="redis-mode">{{ t('wv.form.redisMode') }}</label>
            <select id="redis-mode" v-model="form.redisMode">
              <option value="standalone">standalone</option>
              <option value="cluster">cluster</option>
              <option value="sentinel">sentinel</option>
            </select>
          </div>
          <div v-if="form.redisMode !== 'cluster'" class="field">
            <label for="redis-db">{{ t('wv.form.redisDb') }}</label>
            <input id="redis-db" v-model="form.redisDb" type="number" min="0">
          </div>
        </div>
        <div v-if="form.redisMode === 'cluster'" class="field" :class="{ invalid: errors.clusterNodes }">
          <label for="redis-cluster-nodes">{{ t('wv.form.clusterNodes') }}</label>
          <input
            id="redis-cluster-nodes"
            v-model="form.clusterNodes"
            :placeholder="t('wv.form.clusterNodesHint')"
            @input="clearError('clusterNodes')"
          >
          <p v-if="errors.clusterNodes" class="field-error">{{ t(errors.clusterNodes) }}</p>
        </div>
        <template v-if="form.redisMode === 'sentinel'">
          <div class="field" :class="{ invalid: errors.sentinelNodes }">
            <label for="redis-sentinel-nodes">{{ t('wv.form.sentinelNodes') }}</label>
            <input
              id="redis-sentinel-nodes"
              v-model="form.sentinelNodes"
              :placeholder="t('wv.form.sentinelNodesHint')"
              @input="clearError('sentinelNodes')"
            >
            <p v-if="errors.sentinelNodes" class="field-error">{{ t(errors.sentinelNodes) }}</p>
          </div>
          <div class="grid">
            <div class="field" :class="{ invalid: errors.sentinelName }">
              <label for="redis-sentinel-name">{{ t('wv.form.sentinelName') }}</label>
              <input id="redis-sentinel-name" v-model="form.sentinelName" @input="clearError('sentinelName')">
              <p v-if="errors.sentinelName" class="field-error">{{ t(errors.sentinelName) }}</p>
            </div>
            <div class="field">
              <label for="redis-sentinel-password">{{ t('wv.form.sentinelPassword') }}</label>
              <div class="pw">
                <input id="redis-sentinel-password" :type="showSentinelPassword ? 'text' : 'password'" v-model="form.sentinelPassword" autocomplete="off" @input="onSecretInput('sentinelPassword')">
                <button type="button" class="btn tiny secondary" @click="showSentinelPassword = !showSentinelPassword">{{ showSentinelPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
                <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('sentinelPassword')">{{ t('wv.form.clear') }}</button>
              </div>
              <p v-if="editingId && form.clearSentinelPassword" class="hint">{{ t('wv.form.willClear') }}</p>
              <p v-else-if="editingId && !form.sentinelPassword" class="hint">{{ t('wv.form.secretSaved') }}</p>
            </div>
          </div>
        </template>
        <div class="grid">
          <div class="field">
            <label for="redis-key-separator">{{ t('wv.form.keySeparator') }}</label>
            <input id="redis-key-separator" v-model="form.keySeparator" maxlength="4">
          </div>
          <div class="field">
            <label for="redis-color">{{ t('wv.form.color') }}</label>
            <input id="redis-color" v-model="form.color" :placeholder="t('wv.form.colorHint')">
          </div>
        </div>
        </template>
      </section>

      <details v-if="showAdvanced" class="section collapsible">
        <summary>{{ t('wv.form.advanced') }}</summary>
        <div class="details-body">
          <div v-if="showSsh" class="sub-block">
            <h4>
              {{ t('wv.form.ssh') }}
              <span v-if="form.sshHost" class="badge">{{ t('wv.form.configured') }}</span>
            </h4>
            <p v-if="urlMode" class="hint">{{ t('wv.form.urlSshHint') }}</p>
          <div class="grid">
            <div class="field">
              <label for="ssh-host">{{ t('wv.form.sshHost') }}</label>
              <input id="ssh-host" v-model="form.sshHost">
            </div>
            <div class="field">
              <label for="ssh-port">{{ t('wv.form.sshPort') }}</label>
              <input id="ssh-port" v-model="form.sshPort" type="number" min="1" max="65535">
            </div>
          </div>
          <div class="field">
            <label for="ssh-user">{{ t('wv.form.sshUser') }}</label>
            <input id="ssh-user" v-model="form.sshUser" autocomplete="username">
          </div>
          <div class="field">
            <label for="ssh-password">{{ t('wv.form.sshPass') }}</label>
            <div class="pw">
              <input id="ssh-password" :type="showSshPassword ? 'text' : 'password'" v-model="form.sshPassword" autocomplete="off" @input="onSecretInput('sshPassword')">
              <button type="button" class="btn tiny secondary" @click="showSshPassword = !showSshPassword">{{ showSshPassword ? t('wv.form.hide') : t('wv.form.show') }}</button>
              <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('sshPassword')">{{ t('wv.form.clear') }}</button>
            </div>
            <p v-if="editingId && form.clearSshPassword" class="hint">{{ t('wv.form.willClear') }}</p>
            <p v-else-if="editingId && !form.sshPassword" class="hint">{{ t('wv.form.secretSaved') }}</p>
          </div>
          <div class="field">
            <label for="ssh-key">{{ t('wv.form.sshKey') }}</label>
            <input id="ssh-key" v-model="form.sshPrivateKeyPath" placeholder="~/.ssh/id_ed25519">
          </div>
          <div class="field">
            <label for="ssh-passphrase">{{ t('wv.form.sshPhrase') }}</label>
            <div class="pw">
              <input id="ssh-passphrase" :type="showSshPassphrase ? 'text' : 'password'" v-model="form.sshPassphrase" autocomplete="off" @input="onSecretInput('sshPassphrase')">
              <button type="button" class="btn tiny secondary" @click="showSshPassphrase = !showSshPassphrase">{{ showSshPassphrase ? t('wv.form.hide') : t('wv.form.show') }}</button>
              <button v-if="editingId" type="button" class="btn tiny secondary" @click="clearSecret('sshPassphrase')">{{ t('wv.form.clear') }}</button>
            </div>
            <p v-if="editingId && form.clearSshPassphrase" class="hint">{{ t('wv.form.willClear') }}</p>
            <p v-else-if="editingId && !form.sshPassphrase" class="hint">{{ t('wv.form.secretSaved') }}</p>
          </div>
          </div>

          <div class="sub-block">
            <h4>{{ t('wv.form.tlsAndTimeouts') }}</h4>
            <div class="field">
            <label class="check" for="conn-use-ssl">
              <input id="conn-use-ssl" v-model="form.useSSL" type="checkbox">
              <span>{{ t('wv.form.useSsl') }}</span>
            </label>
          </div>
          <template v-if="form.useSSL">
            <div class="field">
              <label for="conn-ca">{{ t('wv.form.caCert') }}</label>
              <input id="conn-ca" v-model="form.caPath">
            </div>
            <div class="grid">
              <div class="field">
                <label for="conn-client-cert">{{ t('wv.form.clientCert') }}</label>
                <input id="conn-client-cert" v-model="form.clientCertPath">
              </div>
              <div class="field">
                <label for="conn-client-key">{{ t('wv.form.clientKey') }}</label>
                <input id="conn-client-key" v-model="form.clientKeyPath">
              </div>
            </div>
          </template>
          <div class="grid" :class="{ 'one-col': !showConnectTimeout }">
            <div v-if="showConnectTimeout" class="field">
              <label for="conn-connect-timeout">{{ t('wv.form.connTimeout') }}</label>
              <input id="conn-connect-timeout" v-model="form.connectTimeout" type="number" min="0">
            </div>
            <div class="field">
              <label for="conn-request-timeout">{{ t('wv.form.reqTimeout') }}</label>
              <input id="conn-request-timeout" v-model="form.requestTimeout" type="number" min="0" :placeholder="t('wv.form.reqTimeoutPlaceholder')">
            </div>
          </div>
          <div v-if="showSocket" class="field">
            <label for="conn-socket">{{ t('wv.form.socketPath') }}</label>
            <input id="conn-socket" v-model="form.socketPath">
          </div>
          </div>
        </div>
      </details>

      <footer class="actions">
        <div class="status" :class="statusOk ? 'ok' : 'err'" role="status" aria-live="polite">{{ status }}</div>
        <div class="action-buttons">
          <button type="button" class="btn secondary" :disabled="busy" @click="test">
            {{ testing ? t('wv.form.testing') : t('wv.form.test') }}
          </button>
          <button type="button" class="btn secondary" :disabled="busy" @click="cancel">{{ t('wv.form.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="busy">
            {{ saving ? t('wv.form.saving') : t('wv.form.save') }}
          </button>
        </div>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 24px 20px 32px;
  box-sizing: border-box;
}
.panel {
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 22px 26px 0;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.panel,
.panel * {
  box-sizing: border-box;
}
.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
}
.section.first {
  margin-top: 20px;
  padding-top: 0;
  border-top: none;
}
.section h3 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.grid + .grid {
  margin-top: 12px;
}
.grid.one-col {
  grid-template-columns: 1fr;
}

.basic-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr auto;
  gap: 12px;
  margin: 12px 0 14px;
}
.basic-grid .field {
  margin-bottom: 0;
}
.field-check {
  display: flex;
  align-items: flex-end;
}
.field-check .check {
  margin-bottom: 7px;
}
.field {
  min-width: 0;
  margin-bottom: 12px;
}
.grid .field {
  margin-bottom: 0;
}
.grid + .field,
.field + .grid {
  margin-top: 12px;
}
label {
  display: block;
  margin-bottom: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-descriptionForeground, #808080);
}
label.check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  margin: 0;
  color: var(--vscode-foreground, #d4d4d4);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
input,
select {
  width: 100%;
  padding: 7px 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--vscode-input-foreground, #d4d4d4);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
  border-radius: 4px;
}
input:focus,
select:focus {
  outline: none;
  border-color: var(--vscode-focusBorder, #007fd4);
}
input[type="checkbox"] {
  width: auto;
  margin: 0;
  accent-color: var(--vscode-focusBorder, #007fd4);
}
.field.invalid input,
.field.invalid select {
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}
.field-error {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--vscode-errorForeground, #f48771);
}
.hint {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground, #808080);
}
.pw {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pw input {
  flex: 1;
  min-width: 0;
}
.type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.type-card {
  padding: 8px 10px;
  text-align: left;
  color: var(--vscode-button-secondaryForeground, #ffffff);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
.type-card:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
.type-card.active {
  color: var(--vscode-button-foreground, #ffffff);
  background: var(--vscode-button-background, #0e639c);
  border-color: var(--vscode-focusBorder, #007fd4);
}
.type-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
}
.type-desc {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  opacity: 0.75;
}
.mode-switch {
  display: inline-flex;
  gap: 3px;
  margin-bottom: 12px;
  padding: 3px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  border-radius: 5px;
}
.mode-switch button {
  padding: 5px 10px;
  color: var(--vscode-button-secondaryForeground, #ffffff);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
}
.mode-switch button.active {
  color: var(--vscode-button-foreground, #ffffff);
  background: var(--vscode-button-background, #0e639c);
}
.collapsible summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  list-style: none;
}
.collapsible summary::-webkit-details-marker {
  display: none;
}
.collapsible summary::before {
  content: '▸';
  display: inline-block;
  width: 10px;
  transition: transform 0.15s ease;
}
.collapsible[open] > summary::before {
  transform: rotate(90deg);
}
.details-body {
  padding-top: 12px;
}
.sub-block + .sub-block {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
}
.sub-block h4 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground, #d4d4d4);
}
.badge {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 400;
  color: var(--vscode-badge-foreground, #ffffff);
  background: var(--vscode-badge-background, #4d4d4d);
  border-radius: 8px;
}
.btn {
  padding: 8px 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-button-foreground, #ffffff);
  background: var(--vscode-button-background, #0e639c);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.btn:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.btn.secondary {
  color: var(--vscode-button-secondaryForeground, #ffffff);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
.btn.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
.btn.tiny {
  flex: 0 0 auto;
  padding: 7px 10px;
  font-size: 12px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn:focus-visible,
.type-card:focus-visible,
.mode-switch button:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}
.actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 20px -26px 0;
  padding: 12px 26px;
  background: var(--vscode-editorWidget-background, #252526);
  border-top: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 0 0 8px 8px;
}
.action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.status {
  flex: 1 1 220px;
  min-height: 16px;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.status.ok {
  color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991);
}
.status.err {
  color: var(--vscode-errorForeground, #f48771);
}
@media (max-width: 760px) {
  .basic-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 620px) {
  .page {
    padding: 12px;
  }
  .panel {
    padding: 16px 16px 0;
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .actions {
    margin-right: -16px;
    margin-left: -16px;
    padding: 10px 16px;
  }
}
@media (max-width: 480px) {
  .basic-grid {
    grid-template-columns: 1fr;
  }
  .field-check {
    align-items: flex-start;
  }
  .field-check .check {
    margin-bottom: 0;
  }
}
</style>