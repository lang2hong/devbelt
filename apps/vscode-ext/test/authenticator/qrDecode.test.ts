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
  const png = new PNG({ width: 24, height: 24 });
  png.data.fill(255);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
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
});
