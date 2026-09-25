/**
 * 字节工具（二进制安全值渲染）。
 *
 * 纯函数、零依赖，浏览器/Node 通用（不依赖 atob/btoa/Buffer，避免环境差异）。
 * host 侧以 base64 传输原始字节，webview 据此渲染 hex/ascii 并回写。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64.indexOf(clean[i] ?? '');
    const n1 = B64.indexOf(clean[i + 1] ?? '');
    const n2 = clean[i + 2] !== undefined ? B64.indexOf(clean[i + 2]) : -1;
    const n3 = clean[i + 3] !== undefined ? B64.indexOf(clean[i + 3]) : -1;
    if (n0 < 0 || n1 < 0) break;
    if (p < out.length) out[p++] = (n0 << 2) | (n1 >> 4);
    if (n2 >= 0 && p < out.length) out[p++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (n3 >= 0 && p < out.length) out[p++] = ((n2 & 3) << 6) | n3;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array, sep = ' '): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(sep);
}

/** 解析空白分隔的十六进制字节；非法 token 抛错（供保存前校验）。 */
export function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim();
  const tokens = trimmed.length ? trimmed.split(/\s+/) : [];
  const out = new Uint8Array(tokens.length);
  tokens.forEach((tok, i) => {
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) throw new Error(`invalid hex byte: ${tok}`);
    out[i] = parseInt(tok, 16);
  });
  return out;
}

/**
 * 解析最多 `maxBytes` 个十六进制字节（供大值 hex 预览封顶）。
 *
 * 只扫描到上限即停，避免 1MB 值每次键击全量解析；`truncated` 表示是否还有后续字节。
 * 上限之外不校验（完整校验仍由保存路径的 `hexToBytes` 负责）。
 */
export function hexToBytesLimited(hex: string, maxBytes: number): { bytes: Uint8Array; truncated: boolean } {
  const out: number[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hex)) !== null) {
    if (out.length >= maxBytes) return { bytes: new Uint8Array(out), truncated: true };
    const tok = m[0];
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) throw new Error(`invalid hex byte: ${tok}`);
    out.push(parseInt(tok, 16));
  }
  return { bytes: new Uint8Array(out), truncated: false };
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 每字节 ASCII 预览：可打印字符原样，其余以 `.` 占位。 */
export function bytesToAscii(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  return out;
}