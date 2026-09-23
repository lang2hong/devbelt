import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const PNG_DATA_URL_RE = /^data:image\/png;base64,/i;

/**
 * 从 PNG data URL 解码二维码，返回其中的文本（通常是 otpauth:// URI）；未识别到二维码返回 null。
 *
 * 输入非法（非 PNG data URL / base64 损坏 / PNG 解析失败）抛错，由调用方归一为可读错误。
 * 纯函数、零 vscode 依赖，可单测。这是"二维码图片录入"的解码核心：webview 把任意图片
 * （粘贴/拖拽/选择）经 canvas 统一转成 PNG dataURL 回传，主机在此解码——secret 文本只落主机。
 */
export function decodeOtpauthFromPngDataUrl(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string') throw new Error('invalid image payload');
  const m = PNG_DATA_URL_RE.exec(dataUrl);
  if (!m) throw new Error('unsupported image format (expected data:image/png;base64,...)');
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (buf.length === 0) throw new Error('empty image');
  const png = PNG.sync.read(buf);
  const rgba = new Uint8ClampedArray(png.data);
  const result = jsQR(rgba, png.width, png.height);
  return result ? result.data : null;
}
