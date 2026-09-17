/**
 * devkit 浏览器侧身份/会话客户端，供 auth-ui、db-ui、admin-ui 共用。
 *
 * 不含任何 UI（.vue / HTML / 路由 / base），只封装与后端身份 API 的交互：
 * 会话 token、CSRF、401 续期、错误映射。
 */
export type { FetchLike } from './consoleAuth';
export * from './consoleAuth';
export * from './csrf';
export * from './authedFetch';
export * from './tokenStore';
export * from './httpError';
export * from './serverError';
export * from './session';
export * from './linkFlows';
