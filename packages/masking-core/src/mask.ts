import { createHmac } from 'node:crypto';

export type BuiltinRule =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'idCard'
  | 'bankCard'
  | 'redact'
  | 'null'
  | 'hash'
  | 'fixed'
  | 'regex';

export interface MaskingRule {
  rule: BuiltinRule;
  /** `fixed` value. */
  value?: string;
  /** `regex` pattern (global replace) and replacement. */
  pattern?: string;
  replacement?: string;
}

export interface MaskContext {
  /** Project-level secret; never written to the export. */
  salt: string;
  /** Logical domain, e.g. `users.email`. */
  domain: string;
  /** Column length limit; output is truncated when needed. */
  maxLength?: number;
}

const PII_RE = /(^|_)(password|passwd|pwd|token|secret|api_?key|email|phone|mobile|tel|name|address|id_?card|bank_?card|ssn|passport)(_|$)/i;

/** Column-name heuristic used to refuse unconfigured PII exports. */
export function isPiiColumn(name: string): boolean {
  return PII_RE.test(name.trim());
}

/**
 * Deterministic masking: the same salt + domain + input always produces the
 * same output, so joins across exported tables stay consistent.
 */
export function maskValue(rule: MaskingRule, input: unknown, ctx: MaskContext): string | null {
  if (input === null || input === undefined) {
    return rule.rule === 'null' ? null : null;
  }
  const text = typeof input === 'string' ? input : String(input);
  if (rule.rule === 'null') return null;
  if (rule.rule === 'fixed') return clip(rule.value ?? '', ctx.maxLength);
  if (rule.rule === 'redact') return '[REDACTED]';
  if (rule.rule === 'regex') {
    if (!rule.pattern) return '[REDACTED]';
    return clip(text.replace(new RegExp(rule.pattern, 'g'), rule.replacement ?? ''), ctx.maxLength);
  }

  const hex = createHmac('sha256', ctx.salt).update(`${ctx.domain}:${text.trim()}`).digest('hex');
  const digits = hex.split('').map((c) => parseInt(c, 16) % 10).join('');
  switch (rule.rule) {
    case 'email':
      return clip(`u${hex.slice(0, 10)}@masked.invalid`, ctx.maxLength);
    case 'phone':
      return clip(`1${digits.slice(0, 2)}****${digits.slice(2, 6)}`, ctx.maxLength);
    case 'idCard':
      return clip(`110101********${digits.slice(0, 4)}`, ctx.maxLength);
    case 'bankCard':
      return clip(`**** **** **** ${digits.slice(0, 4)}`, ctx.maxLength);
    case 'name':
      return clip(`用户${hex.slice(0, 4)}`, ctx.maxLength);
    case 'address':
      return clip(`地址-${hex.slice(0, 8)}`, ctx.maxLength);
    case 'hash':
      return clip(hex.slice(0, 16), ctx.maxLength);
    default:
      return '[REDACTED]';
  }
}

function clip(value: string, maxLength?: number): string {
  if (maxLength === undefined || maxLength <= 0) return value;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}