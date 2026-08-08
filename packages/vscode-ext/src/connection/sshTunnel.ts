import * as net from 'net';
import * as fs from 'fs';
import { Client } from 'ssh2';
import type { SavedConnection } from './connectionStore';

/**
 * SSH 隧道管理器。
 *
 * 为每个带 SSH 配置的连接创建本地端口转发：
 *   本地:随机端口 → SSH 服务器 → 远程数据库主机:端口
 *
 * 数据库驱动连接 localhost:本地端口，实际通过 SSH 通道到达远程数据库。
 *
 * 设计模式：单例 + 连接池（每个 SavedConnection 一个 SSH 连接）
 */
export class SshTunnel {
  /** connId → 隧道信息 */
  private static readonly tunnels = new Map<string, { ssh: Client; server: net.Server; port: number }>();

  /**
   * 创建或复用 SSH 隧道，返回本地端口。
   * 如果连接无 SSH 配置，直接返回 undefined。
   */
  static async create(conn: SavedConnection): Promise<number | undefined> {
    if (!conn.sshHost) return undefined;

    // 复用已有隧道
    const existing = this.tunnels.get(conn.id);
    if (existing) return existing.port;

    return new Promise<number>((resolve, reject) => {
      const ssh = new Client();
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try { ssh.end(); } catch {}
        reject(err);
      };

      ssh.on('ready', () => {
        if (settled) return;
        const server = net.createServer((socket) => {
          ssh.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            conn.host,
            conn.port,
            (err, stream) => {
              if (err) { socket.destroy(); return; }
              socket.pipe(stream);
              stream.pipe(socket);
              socket.on('error', () => stream.destroy());
              stream.on('error', () => socket.destroy());
            },
          );
        });

        server.on('error', fail);
        server.listen(0, '127.0.0.1', () => {
          if (settled) { server.close(); return; }
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          if (port === 0) {
            fail(new Error('Failed to get local port'));
            return;
          }
          settled = true;
          this.tunnels.set(conn.id, { ssh, server, port });
          resolve(port);
        });
      });

      ssh.on('error', fail);

      // SSH 连接配置
      const config: any = {
        host: conn.sshHost,
        port: conn.sshPort || 22,
        username: conn.sshUser || '',
      };
      if (conn.sshPrivateKeyPath) {
        config.privateKey = fs.readFileSync(conn.sshPrivateKeyPath);
        if (conn.sshPassphrase) {
          config.passphrase = conn.sshPassphrase;
        }
      } else if (conn.sshPassword) {
        config.password = conn.sshPassword;
      }

      ssh.connect(config);
    });
  }

  /** 关闭指定连接的隧道 */
  static close(connId: string): void {
    const tunnel = this.tunnels.get(connId);
    if (!tunnel) return;
    tunnel.server.close();
    tunnel.ssh.end();
    this.tunnels.delete(connId);
  }

  /** 关闭所有隧道 */
  static closeAll(): void {
    for (const [id] of this.tunnels) {
      this.close(id);
    }
  }
}
