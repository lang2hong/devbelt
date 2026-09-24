/**
 * Redis TLS 选项构造。
 *
 * 安全默认与 DevBelt SQL 连接一致：`rejectUnauthorized` 缺省 true。
 * 有意不移植 ARDM 的 `getTLSOptions`——上游硬编码 `rejectUnauthorized:false` 且
 * `checkServerIdentity:()=>undefined`（跳过主机名校验）；见 P7 设计文档 §6.2。
 */
import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

export interface RedisTlsInput {
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  /** 缺省 true（安全默认）；仅显式 false 才放行自签。 */
  rejectUnauthorized?: boolean;
  /** TLS SNI / 证书主机名。 */
  servername?: string;
}

export type RedisTlsOptions = Pick<
  ConnectionOptions,
  'ca' | 'cert' | 'key' | 'rejectUnauthorized' | 'servername'
>;

export function buildRedisTlsOptions(input: RedisTlsInput): RedisTlsOptions {
  const options: RedisTlsOptions = {
    rejectUnauthorized: input.rejectUnauthorized !== false,
  };
  if (input.caPath) options.ca = readFileSync(input.caPath);
  if (input.clientCertPath) options.cert = readFileSync(input.clientCertPath);
  if (input.clientKeyPath) options.key = readFileSync(input.clientKeyPath);
  if (input.servername) options.servername = input.servername;
  return options;
}
