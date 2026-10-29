import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('DevBelt Diagnostics', { log: true });
  }
  return channel;
}

export function diagInfo(message: string, ...args: unknown[]): void {
  getChannel().info(message, ...args);
}

export function diagWarn(message: string, ...args: unknown[]): void {
  getChannel().warn(message, ...args);
}

export function diagError(message: string, ...args: unknown[]): void {
  getChannel().error(message, ...args);
}

/** 打开「DevBelt Diagnostics」输出面板（供「查看日志」入口使用）。 */
export function diagShow(): void {
  getChannel().show(true);
}

export function diagDispose(): void {
  if (channel) {
    channel.dispose();
    channel = undefined;
  }
}