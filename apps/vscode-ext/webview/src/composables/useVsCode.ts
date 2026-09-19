/** VSCode webview API 封装（composable）。 */

// 缓存 acquireVsCodeApi 结果，防止多次调用报错
let _vscode: ReturnType<typeof acquireVsCodeApi> | null = null;

/**
 * 本次 webview 加载的唯一标识。
 *
 * 面板被 VS Code 重新加载（重开/移动/窗口重载）时，整个脚本会重新执行并生成新的
 * loadId；扩展端据此识别「这是新一轮加载」，重置「两次 ready」协议状态。否则重载后
 * 扩展仍以为已初始化过，直接给尚未挂载的目标视图推数据，消息丢失并卡死。
 */
const LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState<T>(): T | undefined;
  setState(state: any): void;
};

export function useVsCode() {
  if (!_vscode) {
    _vscode = acquireVsCodeApi();
  }

  function post(msg: any): void {
    // Vue reactive proxy 无法被 structured clone 序列化，必须先转为纯对象。
    const payload = JSON.parse(JSON.stringify(msg));
    if (payload && typeof payload === 'object') payload.__load = LOAD_ID;
    _vscode!.postMessage(payload);
  }

  function onMessage(handler: (msg: any) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  return { vscode: _vscode!, post, onMessage };
}
