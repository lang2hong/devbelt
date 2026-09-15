import * as net from 'net';
import * as fs from 'fs/promises';
import { Client } from 'ssh2';
import type { SavedConnection } from './connectionStore';
import { isHostKeyTrusted, loadKnownHosts, knownHostsHint, verifyHostKey } from './sshHostKey';

/** SSH 隧道建立超时（ms），避免连接既不 ready 也不 error 时永久挂起。 */
const SSH_TUNNEL_TIMEOUT = 15_000;

/**
 * 主机密钥裁决注入（由扩展激活时配置）。缺省时不注入 → 回退到严格判定
 * （仅用户 known_hosts），保持 fail-closed。
 */
export interface SshHostKeyGate {
  policy: () => 'tofu' | 'strict';
  /** 插件自管 known_hosts 文件（TOFU 接受后写入）。 */
  storeFile: string;
  userKnownHostsFile?: string;
  prompt: (host: string, port: number, fingerprint: string, keyType: string) => Promise<boolean>;
}

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
  /** connId → 隧道信息。记录建隧道时的目标，连接配置变更后须重建。 */
  private static readonly tunnels = new Map<string, {
    ssh: Client;
    server: net.Server;
    port: number;
    sshHost: string;
    sshPort: number;
    remoteHost: string;
    remotePort: number;
  }>();

  /** 主机密钥裁决器（扩展激活时注入）。未注入时回退严格判定。 */
  private static hostKeyGate?: SshHostKeyGate;

  static configureHostKeyGate(gate: SshHostKeyGate | undefined): void {
    this.hostKeyGate = gate;
  }

  private static closeTunnel(tunnel: { ssh: Client; server: net.Server }, connId: string): void {
    try {
      tunnel.server.close();
    } catch {}
    try {
      tunnel.ssh.end();
    } catch {}
    this.tunnels.delete(connId);
  }

  /**
   * 创建或复用 SSH 隧道，返回本地端口。
   * 如果连接无 SSH 配置，直接返回 undefined。
   */
  static async create(conn: SavedConnection): Promise<number | undefined> {
    if (!conn.sshHost) return undefined;
    const sshHost = conn.sshHost;
    const sshPort = conn.sshPort || 22;

    // 复用已有隧道；但主机/端口改动后旧隧道指向错误目标，须重建。
    const existing = this.tunnels.get(conn.id);
    if (existing) {
      const sameTarget =
        existing.sshHost === sshHost &&
        existing.sshPort === sshPort &&
        existing.remoteHost === conn.host &&
        existing.remotePort === conn.port;
      if (sameTarget) return existing.port;
      this.closeTunnel(existing, conn.id);
    }

    // known_hosts 只读一次；校验在 hostVerifier 里同步比对。
    const knownHosts = loadKnownHosts();

    let privateKey: Buffer | undefined;
    if (conn.sshPrivateKeyPath) {
      try {
        privateKey = await fs.readFile(conn.sshPrivateKeyPath);
      } catch {
        throw new Error(`SSH private key file not readable: ${conn.sshPrivateKeyPath}`);
      }
    }

    return new Promise<number>((resolve, reject) => {
      const ssh = new Client();
      let settled = false;
      let hostKeyTrusted = false;
      let hostKeyChecked = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ssh.removeAllListeners();
        try { ssh.end(); } catch {}
        reject(err);
      };

      // hostVerifier 返回 false 时 ssh2 只给出笼统错误；这里补一句可执行的提示。
      const onError = (err: Error): void => {
        if (hostKeyChecked && !hostKeyTrusted) {
          fail(new Error(
            `SSH host key verification failed for ${sshHost}: ` +
            `host not in known_hosts or key mismatch. ${knownHostsHint(sshHost, sshPort)}`,
          ));
          return;
        }
        fail(err);
      };

      ssh.on('ready', () => {
        if (settled) return;
        ssh.removeListener('error', onError);
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
          if (timer) clearTimeout(timer);
          this.tunnels.set(conn.id, { ssh, server, port, sshHost, sshPort, remoteHost: conn.host, remotePort: conn.port });
          resolve(port);
        });
      });

      ssh.on('error', onError);

      // 超时保护：SSH 连接既不 ready 也不 error 时，中止并反馈明确错误
      timer = setTimeout(() => {
        fail(new Error('SSH tunnel connection timed out'));
      }, SSH_TUNNEL_TIMEOUT);

      // SSH 连接配置
      const config: any = {
        host: sshHost,
        port: sshPort,
        username: conn.sshUser || '',
        // 主机密钥校验：由注入的 gate 按 strict/tofu 裁决；不匹配/revoked 硬失败。
        // ssh2 的异步 hostVerifier：判定完成后调用 callback(decision)。
        hostVerifier: (key: Buffer, callback: (ok: boolean) => void): void => {
          hostKeyChecked = true;
          const gate = SshTunnel.hostKeyGate;
          if (!gate) {
            hostKeyTrusted = isHostKeyTrusted(sshHost, sshPort, key, knownHosts);
            callback(hostKeyTrusted);
            return;
          }
          verifyHostKey({
            policy: gate.policy(),
            host: sshHost,
            port: sshPort,
            keyBlob: key,
            pluginStoreFile: gate.storeFile,
            userKnownHostsFile: gate.userKnownHostsFile,
            prompt: gate.prompt,
          })
            .then((ok) => { hostKeyTrusted = ok; callback(ok); })
            .catch(() => { hostKeyTrusted = false; callback(false); });
        },
      };
      if (privateKey) {
        config.privateKey = privateKey;
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
    this.closeTunnel(tunnel, connId);
  }

  /** 关闭所有隧道 */
  static closeAll(): void {
    for (const [id] of this.tunnels) {
      this.close(id);
    }
  }
}
