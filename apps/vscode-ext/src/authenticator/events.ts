/**
 * Authenticator 数据变更事件（对齐 ConnectionChangedEvent/DataChangeEvent 的类型化事件总线用法）。
 *
 * 字段最小化：只含 kind/operation/id，不传完整对象——消费方（S2 的 provider）
 * 收到后重新 list+snapshot 即可，避免事件体与 Store 内部状态不一致。
 * source 固定为 'AuthenticatorStore'，便于日志/审计按来源过滤。
 */

import { AppEvent } from '@devbelt/db-host/utils/event';

export type AuthenticatorChangeKind = 'entry' | 'group' | 'tag';
export type AuthenticatorChangeOperation = 'create' | 'update' | 'delete';

export class AuthenticatorChangedEvent extends AppEvent {
  constructor(
    readonly kind: AuthenticatorChangeKind,
    readonly operation: AuthenticatorChangeOperation,
    readonly id: string,
  ) {
    super('AuthenticatorStore');
  }
}
