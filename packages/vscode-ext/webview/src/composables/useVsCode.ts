/** VSCode webview API 封装（composable）。 */

// 缓存 acquireVsCodeApi 结果，防止多次调用报错
let _vscode: ReturnType<typeof acquireVsCodeApi> | null = null;

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
    _vscode!.postMessage(msg);
  }

  function onMessage(handler: (msg: any) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  return { vscode: _vscode!, post, onMessage };
}
