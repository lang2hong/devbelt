/**
 * 连接表单的纯校验逻辑（无 Vue / vscode 依赖，便于单测）。
 *
 * 返回字段 → i18n 错误 key；空对象表示通过。
 * 只校验“提交前必须知道”的字段，敏感字段的三态语义仍由 ConnectionFormView.collect 维护。
 */

export type ConnectionFormField =
  | 'host'
  | 'port'
  | 'dbPath'
  | 'connectionUrl'
  | 'clusterNodes'
  | 'sentinelNodes'
  | 'sentinelName';

export type ConnectionFormErrors = Partial<Record<ConnectionFormField, string>>;

export interface ConnectionFormValidationInput {
  dbType: string;
  host: string;
  /** 编辑回填时 SavedConnection.port 是 number；新建表单是 string。 */
  port: string | number;
  dbPath: string;
  useConnectionString: boolean;
  connectionUrl: string;
  redisMode: string;
  clusterNodes: string;
  sentinelNodes: string;
  sentinelName: string;
}

const URL_SCHEMES: Record<string, string[]> = {
  MYSQL: ['mysql:'],
  PG: ['postgres:', 'postgresql:'],
};

/** 连接串模式仅 SQL 连接支持；Redis/ES 的连接目标不是 URL。 */
export function supportsConnectionUrl(dbType: string): boolean {
  return dbType === 'MYSQL' || dbType === 'PG';
}

function validConnectionUrl(dbType: string, raw: string): boolean {
  const schemes = URL_SCHEMES[dbType] ?? [];
  try {
    return schemes.includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

export function validateConnectionForm(input: ConnectionFormValidationInput): ConnectionFormErrors {
  const errors: ConnectionFormErrors = {};

  if (input.dbType === 'SQLITE') {
    if (!input.dbPath.trim()) errors.dbPath = 'wv.form.errSqlitePath';
    return errors;
  }

  if (supportsConnectionUrl(input.dbType) && input.useConnectionString) {
    const raw = input.connectionUrl.trim();
    if (!raw) {
      errors.connectionUrl = 'wv.form.errUrlRequired';
    } else if (!validConnectionUrl(input.dbType, raw)) {
      errors.connectionUrl = 'wv.form.errUrlInvalid';
    }
    return errors;
  }

  if (!input.host.trim()) errors.host = 'wv.form.errHost';

  const portText = String(input.port ?? '').trim();
  const port = Number(portText);
  if (!portText || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = 'wv.form.errPort';
  }

  if (input.dbType === 'REDIS') {
    if (input.redisMode === 'cluster' && !input.clusterNodes.trim()) {
      errors.clusterNodes = 'wv.form.errClusterNodes';
    }
    if (input.redisMode === 'sentinel') {
      if (!input.sentinelNodes.trim()) errors.sentinelNodes = 'wv.form.errSentinelNodes';
      if (!input.sentinelName.trim()) errors.sentinelName = 'wv.form.errSentinelName';
    }
  }

  return errors;
}