/**
 * 数据访问层接口（Repository 模式）— barrel。
 *
 * 接口按聚合拆到 ./interfaces/*.ts（admin/user/sync/billing/platform）：
 * 单文件 813 行时代，任一聚合改字段都在整文件层面产生冲突。此处仅 re-export，
 * 既有 import 站点（../interfaces.js）零改动。
 */
export * from "./interfaces/admin.js";
export * from "./interfaces/user.js";
export * from "./interfaces/plan.js";
export * from "./interfaces/sync.js";
export * from "./interfaces/billing.js";
export * from "./interfaces/platform.js";
