import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { decodeOtpauthFromPngDataUrl } from '../../src/authenticator/qrDecode';

async function qrPngDataUrl(text: string): Promise<string> {
  const buf = await QRCode.toBuffer(text, { type: 'png', margin: 1, width: 256 });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** 有效 PNG 但无二维码（纯白）。 */
function blankPngDataUrl(): string {
  return `data:image/png;base64,${pngBufBlank().toString('base64')}`;
}
function pngBufBlank(): Buffer {
  const png = new PNG({ width: 24, height: 24 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

describe('decodeOtpauthFromPngDataUrl', () => {
  it('decodes an otpauth URI from a QR PNG', async () => {
    const uri = 'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30';
    const dataUrl = await qrPngDataUrl(uri);
    expect(decodeOtpauthFromPngDataUrl(dataUrl)).toBe(uri);
  });

  it('returns null for a valid PNG that has no QR code', () => {
    expect(decodeOtpauthFromPngDataUrl(blankPngDataUrl())).toBeNull();
  });

  it('throws on non-PNG / malformed data URLs', () => {
    expect(() => decodeOtpauthFromPngDataUrl('data:image/jpeg;base64,AAAA')).toThrow();
    expect(() => decodeOtpauthFromPngDataUrl('not-a-data-url')).toThrow();
    expect(() => decodeOtpauthFromPngDataUrl('data:image/png;base64,')).toThrow();
  });

  it('round-trips a plaintext label (non-otpauth content is still returned)', async () => {
    const dataUrl = await qrPngDataUrl('hello-qr');
    expect(decodeOtpauthFromPngDataUrl(dataUrl)).toBe('hello-qr');
  });

  it('decodes a small QR (exercises the 2x-upscale retry path)', async () => {
    const uri = 'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme';
    const buf = await QRCode.toBuffer(uri, { type: 'png', margin: 1, width: 64 });
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    expect(decodeOtpauthFromPngDataUrl(dataUrl)).toBe(uri);
  });

  it('rejects payloads over the byte cap (image bomb guard)', () => {
    // 8MB 字节上限：构造 > 8MB 的 base64（不触达 PNG 解析）
    const big = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1024) * 4 / 3));
    expect(() => decodeOtpauthFromPngDataUrl(big)).toThrow(/too large/);
  });

  it('rejects images over the pixel cap', () => {
    const png = new PNG({ width: 4100, height: 4100 }); // 16.81M px > 16M
    png.data.fill(255);
    const dataUrl = `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
    expect(() => decodeOtpauthFromPngDataUrl(dataUrl)).toThrow(/dimensions too large/);
  });

  it('rejects overflowing IHDR dimensions before PNG.sync.read (no allocation)', () => {
    const buf = pngBufBlank();
    buf.writeUInt32BE(65536, 16); // width
    buf.writeUInt32BE(65536, 20); // height
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    expect(() => decodeOtpauthFromPngDataUrl(dataUrl)).toThrow(/dimensions too large/);
  });

  it('rejects interlaced PNG (pngjs interlace inflate has no cap)', () => {
    const buf = pngBufBlank();
    buf[28] = 1; // interlace method
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    expect(() => decodeOtpauthFromPngDataUrl(dataUrl)).toThrow(/interlaced/);
  });
});
