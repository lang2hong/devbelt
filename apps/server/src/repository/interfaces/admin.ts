import type {
  Order,
  Invoice,
} from "../../domain/entities.js";
import type {
  UserStatus,
  UserRole,
} from "../../domain/enums.js";

/** 仓储接口 · admin（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface AdminUserRow {
  userId: number;
  email: string;
  emailVerifiedTime: Date | null;
  displayName?: string;
  status: UserStatus;
  role: UserRole;
  lastLoginTime: Date | null;
  createTime: Date;
  planCode: string | null;
  deviceCount: number;
  /** 个人订阅当前版本（供乐观订阅调整 expectedVersion）。 */
  subscriptionVersion: number | null;
  periodEndTime: Date | null;
}

export interface AdminUserFilter {
  emailExact?: string;
  userId?: number;
  status?: UserStatus;
  planCode?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: number;
  limit: number;
}

export interface AdminOrderFilter {
  userId?: number;
  status?: Order['status'];
  channel?: Order['channel'];
  planCode?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: number;
  limit: number;
}

export interface AdminInvoiceFilter {
  userId?: number;
  status?: Invoice['status'];
  cursor?: number;
  limit: number;
}
