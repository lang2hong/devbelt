import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const PNG_DATA_URL_RE = /^data:image\/png;base64,/i;
/** 解码前上限：防"图片炸弹"（异常/被构造的 dataURL）。 */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

/**
 * 从 PNG data URL 解码二维码，返回其中的文本（通常是 otpauth:// URI）；未识别到二维码返回 null。
 *
 * 输入非法（非 PNG data URL / base64 损坏 / PNG 解析失败 / 超字节或像素上限）抛错，
 * 由调用方归一为可读错误。对较小的图（最长边 < 512）若原生尺寸解不出，做一次 2× 最近邻放大重试，
 * 提升"小二维码"识别率。纯函数、零 vscode 依赖，可单测。
 */
export function decodeOtpauthFromPngDataUrl(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string') throw new Error('invalid image payload');
  const m = PNG_DATA_URL_RE.exec(dataUrl);
  if (!m) throw new Error('unsupported image format (expected data:image/png;base64,...)');
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (buf.length === 0) throw new Error('empty image');
  if (buf.length > MAX_BYTES) throw new Error('image too large');
  const png = PNG.sync.read(buf);
  if (png.width * png.height > MAX_PIXELS) throw new Error('image dimensions too large');

  let result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!result && Math.max(png.width, png.height) < 512) {
    const up = upscale2x(png.width, png.height, png.data);
    result = jsQR(up, png.width * 2, png.height * 2);
  }
  return result ? result.data : null;
}

/** 2× 最近邻放大（保持 RGBA 顺序）。 */
function upscale2x(w: number, h: number, data: Uint8Array): Uint8ClampedArray {
  const w2 = w * 2;
  const h2 = h * 2;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = y >> 1;
    for (let x = 0; x < w2; x++) {
      const si = (sy * w + (x >> 1)) * 4;
      const di = (y * w2 + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return out;
}
