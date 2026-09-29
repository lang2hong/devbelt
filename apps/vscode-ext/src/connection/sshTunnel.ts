import * as net from 'net';
import * as fs from 'fs/promises';
import { Client } from 'ssh2';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { isHostKeyTrusted, loadKnownHosts, knownHostsHint, verifyHostKey } from './sshHostKey';
import { diagError } from '../utils/diagnostics';

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
  prompt: (host: string, port: number, fingerprint: string, keyType: string) => Promise<boolean | 'once'>;
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
    sshUser?: string;
    sshPassword?: string;
    sshPrivateKeyPath?: string;
    sshPassphrase?: string;
  }>();

  /** 主机密钥裁决器（扩展激活时注入）。未注入时回退严格判定。 */
  private static hostKeyGate?: SshHostKeyGate;

  /**
   * connId → 引用计数。
   *
   * B2：同一连接的多库会话复用同一条隧道。会话失败/关闭只能释放自己的引用，
   * 计数归零才真正关隧道——否则衍生会话失败会把主会话仍在用的隧道关掉。
   */
  private static readonly refs = new Map<string, number>();

  /** connId → 在途创建 Promise：同一连接并发 create 合并为一次（不各自建隧道）。 */
  private static readonly creating = new Map<string, Promise<number>>();

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
    this.refs.delete(connId);
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
      // 除目标外还要比较认证身份：换了 SSH 用户/密码/私钥后复用旧隧道会用错身份，
      // 造成权限错配或认证失败。
      const sameTarget =
        existing.sshHost === sshHost &&
        existing.sshPort === sshPort &&
        existing.remoteHost === conn.host &&
        existing.remotePort === conn.port &&
        existing.sshUser === conn.sshUser &&
        existing.sshPassword === conn.sshPassword &&
        existing.sshPrivateKeyPath === conn.sshPrivateKeyPath &&
        existing.sshPassphrase === conn.sshPassphrase;
      if (sameTarget) {
        this.refs.set(conn.id, (this.refs.get(conn.id) ?? 1) + 1);
        return existing.port;
      }
      this.closeTunnel(existing, conn.id);
    }

    // 已有同 id 的在途创建：合并到同一个请求，成功后各计一次引用。
    const inflight = this.creating.get(conn.id);
    if (inflight) {
      const port = await inflight;
      this.refs.set(conn.id, (this.refs.get(conn.id) ?? 1) + 1);
      return port;
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

    const promise = new Promise<number>((resolve, reject) => {
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

      /** 已接入的本地转发 socket：隧道断开时需一并 destroy，否则连接会悬空。 */
      const liveSockets = new Set<import('net').Socket>();

      /** 隧道建立后断线/报错时的清理：关闭转发 socket、本地 server 与 ssh 连接并移出 map。 */
      const teardown = (): void => {
        for (const s of liveSockets) { try { s.destroy(); } catch { /* already destroyed */ } }
        liveSockets.clear();
        const t = this.tunnels.get(conn.id);
        if (!t) return;
        this.tunnels.delete(conn.id);
        this.refs.delete(conn.id);
        try { t.server.close(); } catch { /* already closed */ }
        try { t.ssh.end(); } catch { /* already ended */ }
      };

      ssh.on('ready', () => {
        if (settled) return;
        // 不摘除 error 监听：ready 之后连接中断时若无监听者，ssh2 的 'error'
        // 会变成 Node 未捕获异常，且隧道会残留。这里改为记录并清理。
        ssh.on('error', (err: Error) => { diagError('ssh tunnel dropped', err.message); teardown(); });
        ssh.on('close', teardown);
        const server = net.createServer((socket) => {
          // 记录活动 socket，隧道断开时统一 destroy；否则已建立的转发连接会残留。
          liveSockets.add(socket);
          socket.on('close', () => liveSockets.delete(socket));
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

        // ready 之后 settled=true，用 fail 会被吞掉；转发 server 的错误必须清理并记录。
        server.on('error', (err: Error) => { diagError('ssh forward server error', err.message); teardown(); });
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
          this.tunnels.set(conn.id, {
            ssh, server, port, sshHost, sshPort, remoteHost: conn.host, remotePort: conn.port,
            sshUser: conn.sshUser, sshPassword: conn.sshPassword,
            sshPrivateKeyPath: conn.sshPrivateKeyPath, sshPassphrase: conn.sshPassphrase,
          });
          this.refs.set(conn.id, 1);
          resolve(port);
        });
      });

      ssh.on('error', onError);

      // 超时保护：SSH 连接既不 ready 也不 error 时，中止并反馈明确错误。
      // 注意与 TOFU 弹窗的竞争：等待用户确认主机密钥可能超过 15s，若计时器照跑，
      // 用户还在弹窗上时就被「连接超时」中止。故等待确认期间暂停计时，确认后再重新计时。
      const armTimeout = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          fail(new Error('SSH tunnel connection timed out'));
        }, SSH_TUNNEL_TIMEOUT);
      };
      const pauseTimeout = (): void => {
        if (timer) { clearTimeout(timer); timer = undefined; }
      };
      armTimeout();

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
          // 用户可能长时间停留在确认弹窗上：期间不计入 15s 建连超时。
          pauseTimeout();
          verifyHostKey({
            policy: gate.policy(),
            host: sshHost,
            port: sshPort,
            keyBlob: key,
            pluginStoreFile: gate.storeFile,
            userKnownHostsFile: gate.userKnownHostsFile,
            prompt: gate.prompt,
          })
            .then((ok) => { hostKeyTrusted = ok; if (!settled) armTimeout(); callback(ok); })
            .catch(() => { hostKeyTrusted = false; if (!settled) armTimeout(); callback(false); });
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
    this.creating.set(conn.id, promise);
    try {
      return await promise;
    } finally {
      if (this.creating.get(conn.id) === promise) this.creating.delete(conn.id);
    }
  }

  /**
 * 释放一次隧道引用；计数归零才真正关闭。
 *
 * 会话关闭/建连失败走这里（而非 `close`），保证多库会话共享的隧道在仍有
 * 其它引用时不被误关。
 */
  static release(connId: string): void {
    const n = this.refs.get(connId);
    if (n === undefined) return;
    if (n > 1) { this.refs.set(connId, n - 1); return; }
    const tunnel = this.tunnels.get(connId);
    this.refs.delete(connId);
    if (tunnel) this.closeTunnel(tunnel, connId);
  }

  /** 强制关闭指定连接的隧道（忽略引用计数；disposeAll / 连接彻底销毁用） */
  static close(connId: string): void {
    this.refs.delete(connId);
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
