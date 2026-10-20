/** 审计事件类型 / 对象类型的中文对照（查不到回退原值）。 */
const EVENT_LABELS: Record<string, string> = {
  'admin.users.read': '读取用户数据',
  'admin.audit.read': '读取审计日志',
  'admin.orders.read': '读取订单',
  'admin.invoices.read': '读取发票',
  'admin.plans.read': '读取套餐',
  'admin.user.disabled': '禁用用户',
  'admin.user.enabled': '启用用户',
  'admin.user.role.changed': '变更用户角色',
  'admin.user.subscription.changed': '调整用户订阅',
  'admin.plan.updated': '更新套餐',
  'admin.plan-feature-def.updated': '更新特性定义',
  'admin.order.refunded': '订单退款',
  'admin.invoice.processed': '处理发票',
  'admin.audit.exported': '导出审计日志',
  'admin.ai.billing.read': '读取 AI 计费配置',
  'admin.ai.billing_settings.updated': '更新 AI 计费设置',
  'admin.ai.finance.read': '读取 AI 财务月报',
  'admin.ai.model_pricing.created': '新增模型计价',
  'admin.ai.model_pricing.updated': '更新模型计价',
  'admin.ai.provider.created': '新增模型厂商',
  'admin.ai.provider.updated': '更新模型厂商',
  'admin.ai.providers.read': '读取模型厂商',
  'admin.ai.quota.read': '查询用户 AI 数据',
  'admin.ai.skus.read': '读取积分档位',
  'admin.ai.sku.updated': '更新积分档位',
  'admin.ai.topup.manual_created': '手工积分充值建单',
  'admin.ai.topup.fulfilled': '积分充值入账',
  'admin.ai.topup.refunded': '积分充值退款',
  'admin.role.granted': '授予管理员',
  'admin.role.revoked': '撤销管理员',
  'auth.refresh.reuse': '刷新令牌复用（安全事件）',
  'console.auth.refresh.reuse': '控制台刷新令牌复用（安全事件）',
};

const TARGET_LABELS: Record<string, string> = {
  user: '用户',
  subscription: '订阅',
  order: '订单',
  invoice: '发票',
  plan: '套餐',
  plan_feature_def: '套餐特性',
  audit: '审计',
};

export function auditEventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

export function auditTargetLabel(targetType: string | null): string {
  if (!targetType) return '—';
  return TARGET_LABELS[targetType] ?? targetType;
}
