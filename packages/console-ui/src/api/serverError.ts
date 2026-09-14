/**
 * 服务端错误信封解析（P3 §6 统一契约 `{ error: { code, message } }`，兼容平铺 `{ code }`）。
 * 与 httpError.resolveErrorKind 分工：后者只判重试 kind，本书只提取可展示的 code/message。
 */
export interface ServerError {
  code: string;
  message: string;
}

export async function readServerError(res: Response): Promise<ServerError | null> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    const code = body?.error?.code ?? body?.code;
    if (code) {
      // 服务端 DomainError 出站是扁平 { message, code }（见 middleware/errorHandler.ts
      // domainErrorBody）；嵌套 { error: { code, message } } 是历史/兼容形态。message 优先取
      // 嵌套形，缺失时回退扁平形，否则调用方永远拿到空字符串只能展示裸 code。
      const message = body?.error?.message ?? body?.message ?? '';
      return { code, message };
    }
  } catch {
    // 非 JSON 响应或无错误信封
  }
  return null;
}