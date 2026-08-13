import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('DB Client Diagnostics', { log: true });
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

export function diagDispose(): void {
  if (channel) {
    channel.dispose();
    channel = undefined;
  }
}