/** VSCode webview API 封装（composable）。 */
declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState<T>(): T | undefined;
  setState(state: any): void;
};

export function useVsCode() {
  const vscode = acquireVsCodeApi();

  function post(msg: any): void {
    vscode.postMessage(msg);
  }

  function onMessage(handler: (msg: any) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  return { vscode, post, onMessage };
}
