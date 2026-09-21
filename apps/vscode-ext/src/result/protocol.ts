/**
 * Webview 与扩展之间的消息协议类型（零 vscode 依赖，webview 也从此处 import）。
 *
 * 过去两端各自用裸字符串/`any`：`mode` 是一个字符串联合、消息只有隐式约定，改动
 * 靠人记。这里集中声明已知消息与视图模式，App.vue 与扩展侧共用，避免漂移。
 */

/** App.vue 顶层视图模式（扩展在 `init` 消息里下发）。 */
export type WebviewMode =
  | 'query'
  | 'design'
  | 'status'
  | 'er'
  | 'connectionForm'
  | 'userManage'
  | 'dataDiff'
  | 'dashboard'
  | 'auditLog'
  | 'poolStatus'
  | 'loginForm'
  | 'session'
  | 'account'
  | 'plans'
  /** 账户中心：单面板 + 标签页（账户 / 设备 / 套餐）。 */
  | 'accountHub';

/** 账户中心标签。 */
export type HubTab = 'account' | 'session' | 'plans';

/** 所有消息的松散基类：`type` 为判别字段，其余按具体消息扩展。 */
export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

/** 扩展 → webview：切换视图并下发语言。`isZh` 由 BaseWebView.post 统一注入。 */
export interface WebviewInitMessage extends WebviewMessage {
  type: 'init';
  mode?: WebviewMode;
  isZh?: boolean;
  /** accountHub 初始标签。 */
  tab?: HubTab;
}

/**
 * webview → 扩展：视图已挂载。
 *
 * `__load` 是本次 webview 加载的唯一标识（useVsCode 生成），扩展据此识别面板
 * 重载并重置「两次 ready」协议。
 */
export interface WebviewReadyMessage extends WebviewMessage {
  type: 'ready';
  __load?: string;
}

/** 扩展 → webview：统一错误边界兜底。 */
export interface WebviewErrorMessage extends WebviewMessage {
  type: 'error';
  message: string;
}