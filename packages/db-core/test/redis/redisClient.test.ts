import { describe, expect, it } from 'vitest';
import type { RedisOptions } from 'ioredis';
import {
  RedisClient,
  RedisReadOnlyError,
  redactCommandArgs,
  type RedisClientOptions,
  type RedisCommandLog,
  type RedisConnectionLike,
} from '../../src/redis/redisClient';

type Listener = (...args: unknown[]) => void;

/** 最小 ioredis 假实现：call 走 sendCommand，支持 ready/error/end 事件。 */
class FakeRedis implements RedisConnectionLike {
  status = 'ready';
  error: Error | null = null;
  reply: unknown = 'OK';
  quitCalled = 0;
  disconnectCalled = 0;
  readonly calls: { name: string; args: string[] }[] = [];
  readonly replyEncodings: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  sendCommand = async (command: { name: string; args: string[] }): Promise<unknown> => {
    this.calls.push({ name: command.name, args: command.args });
    this.replyEncodings.push((command as { replyEncoding?: unknown }).replyEncoding);
    if (this.error) throw this.error;
    return this.reply;
  };

  async call(command: string, ...args: (string | number)[]): Promise<unknown> {
    return this.sendCommand({ name: command, args: args.map((a) => String(a)) });
  }

  async ping(): Promise<string> {
    return String(await this.call('PING'));
  }

  async info(section?: string): Promise<string> {
    return String(await this.call('INFO', ...(section ? [section] : [])));
  }

  async quit(): Promise<unknown> {
    this.quitCalled++;
    this.status = 'end';
    return 'OK';
  }

  disconnect(): void {
    this.disconnectCalled++;
    this.status = 'end';
  }

  removeListener(event: string, listener: Listener): unknown {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }

  once(event: string, listener: Listener): unknown {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    const list = this.listeners.get(event);
    if (list) list.push(wrapped); else this.listeners.set(event, [wrapped]);
    return this;
  }

  on(event: string, listener: Listener): unknown {
    const list = this.listeners.get(event);
    if (list) list.push(listener); else this.listeners.set(event, [listener]);
    return this;
  }

  /** 测试用：触发事件。 */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

function make(options: Partial<RedisClientOptions> = {}) {
  const fake = new FakeRedis();
  const captured: RedisOptions[] = [];
  const client = new RedisClient(
    { host: '127.0.0.1', port: 6379, ...options },
    (opts) => {
      captured.push(opts);
      return fake;
    },
  );
  return { fake, client, captured };
}

describe('RedisClient 配置', () => {
  it('ioredis 配置复制 ARDM（stringNumbers/enableReadyCheck/family/connectTimeout）', () => {
    const { captured } = make();
    const opts = captured[0];
    expect(opts.stringNumbers).toBe(true);
    expect(opts.enableReadyCheck).toBe(false);
    expect(opts.family).toBe(0);
    expect(opts.connectTimeout).toBe(30_000);
  });

  it('retryStrategy 与 ARDM 一致：200→400→停止（1000 上限不可达）', () => {
    const { captured } = make();
    const retry = captured[0].retryStrategy as (times: number) => number | null;
    expect(retry(1)).toBe(200);
    expect(retry(2)).toBe(400);
    expect(retry(3)).toBeNull();
    expect(retry(4)).toBeNull();
  });

  it('命令超时：命令永不 settle 时有界失败（集群宕机不挂起）', async () => {
    class HangRedis extends FakeRedis {
      sendCommand = (): Promise<unknown> => new Promise(() => { /* 永不 settle */ });
    }
    const client = new RedisClient({ host: 'h', port: 1, commandTimeout: 20 }, () => new HangRedis());
    await expect(client.sendCommand('GET', ['k'])).rejects.toThrow(/timed out after 20ms/);
  });

  it('TLS 选项透传给 ioredis', () => {
    const { captured } = make({ tls: { rejectUnauthorized: false, servername: 'r.example' } });
    expect(captured[0].tls).toEqual({ rejectUnauthorized: false, servername: 'r.example' });
  });
});

describe('RedisClient connect() 生命周期', () => {
  it('已 ready：直接返回', async () => {
    const { client } = make();
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('终态 end：立即失败，不永久挂起', async () => {
    const { client, fake } = make();
    fake.status = 'end';
    await expect(client.connect()).rejects.toThrow(/has ended/);
  });

  it('等待后 ready：resolve', async () => {
    const { client, fake } = make();
    fake.status = 'connecting';
    const pending = client.connect();
    fake.status = 'ready';
    fake.emit('ready');
    await expect(pending).resolves.toBeUndefined();
  });

  it('首个 error：reject', async () => {
    const { client, fake } = make();
    fake.status = 'connecting';
    const pending = client.connect();
    fake.emit('error', new Error('ECONNREFUSED'));
    await expect(pending).rejects.toThrow('ECONNREFUSED');
  });

  it('等待期间 end：reject（不再挂起）', async () => {
    const { client, fake } = make();
    fake.status = 'connecting';
    const pending = client.connect();
    fake.emit('end');
    await expect(pending).rejects.toThrow(/ended before ready/);
  });

  it('就绪后清理监听，后续事件不再影响已 settle 的 Promise', async () => {
    const { client, fake } = make();
    fake.status = 'connecting';
    const pending = client.connect();
    fake.emit('ready');
    await pending;
    // 再次触发 error 不应产生未处理拒绝。
    expect(() => fake.emit('error', new Error('late'))).not.toThrow();
  });
});

describe('RedisClient 只读拦截', () => {
  it('写命令被拦截，读命令放行', async () => {
    const { client, fake } = make({ readOnly: true });
    await expect(client.sendCommand('SET', ['k', 'v'])).rejects.toBeInstanceOf(RedisReadOnlyError);
    expect(fake.calls).toHaveLength(0);

    await expect(client.sendCommand('GET', ['k'])).resolves.toBe('OK');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ name: 'GET', args: ['k'] });
  });

  it('admin 写命令 denylist 也被拦截（ARDM 会漏）', async () => {
    const { client, fake } = make({ readOnly: true });
    for (const [name, args] of [
      ['CONFIG', ['SET', 'a', 'b']],
      ['ACL', ['SETUSER', 'u']],
      ['SHUTDOWN', []],
      ['MODULE', ['LOAD', '/x.so']],
      ['DEBUG', ['SEGFAULT']],
    ] as [string, string[]][]) {
      await expect(client.sendCommand(name, args)).rejects.toBeInstanceOf(RedisReadOnlyError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('读命令 SCAN/GET/TTL 放行，写命令 SET/DEL 拦截', async () => {
    const { client, fake } = make({ readOnly: true });
    for (const [name, args] of [['SCAN', ['0']], ['GET', ['k']], ['TTL', ['k']]] as [string, string[]][]) {
      await expect(client.sendCommand(name, args)).resolves.toBeDefined();
    }
    for (const [name, args] of [['SET', ['k', 'v']], ['DEL', ['k']]] as [string, string[]][]) {
      await expect(client.sendCommand(name, args)).rejects.toBeInstanceOf(RedisReadOnlyError);
    }
    expect(fake.calls.map((c) => c.name)).toEqual(['SCAN', 'GET', 'TTL']);
  });

  it('fail-closed：未收录命令/子命令一律拦截（FCALL/FUNCTION/CLUSTER RESET/PFADD/XREADGROUP）', async () => {
    const { client, fake } = make({ readOnly: true });
    for (const [name, args] of [
      ['FCALL', ['f', '1', 'k']],
      ['FUNCTION', ['LOAD']],
      ['CLUSTER', ['RESET']],
      ['CLUSTER', ['FAILOVER']],
      ['MODULE', ['LOADEX', '/x.so']],
      ['CONFIG', ['REWRITE']],
      ['PFADD', ['hll', 'x']],
      ['XREADGROUP', ['GROUP', 'g', 'c', 'STREAMS', 's', '>']],
    ] as [string, string[]][]) {
      await expect(client.sendCommand(name, args), `${name} ${args.join(' ')}`).rejects.toBeInstanceOf(RedisReadOnlyError);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('fail-closed：已知只读 admin 子命令放行（CONFIG GET/CLUSTER INFO/SLOWLOG GET/MEMORY USAGE）', async () => {
    const { client } = make({ readOnly: true });
    for (const [name, args] of [
      ['CONFIG', ['GET', 'maxmemory']],
      ['CLUSTER', ['INFO']],
      ['SLOWLOG', ['GET', '10']],
      ['MEMORY', ['USAGE', 'k']],
    ] as [string, string[]][]) {
      await expect(client.sendCommand(name, args), `${name} ${args.join(' ')}`).resolves.toBeDefined();
    }
  });

  it('fail-closed：SENTINEL 只读子命令放行、写子命令拦截（sentinel-over-SSH 需要）', async () => {
    const { client } = make({ readOnly: true });
    await expect(client.sendCommand('SENTINEL', ['get-master-addr-by-name', 'm'])).resolves.toBeDefined();
    await expect(client.sendCommand('SENTINEL', ['MASTERS'])).resolves.toBeDefined();
    await expect(client.sendCommand('SENTINEL', ['RESET', 'm'])).rejects.toBeInstanceOf(RedisReadOnlyError);
    await expect(client.sendCommand('SENTINEL', ['SET', 'm', 'a', 'b'])).rejects.toBeInstanceOf(RedisReadOnlyError);
  });

  it('fail-closed：ACL LOG 放行、ACL LOG RESET 拦截', async () => {
    const { client } = make({ readOnly: true });
    await expect(client.sendCommand('ACL', ['LOG', '10'])).resolves.toBeDefined();
    await expect(client.sendCommand('ACL', ['LOG', 'RESET'])).rejects.toBeInstanceOf(RedisReadOnlyError);
  });

  it('D11：cluster 节点路径不绕过只读（nodes().call 写命令被拦截）', async () => {
    class ClusterFake extends FakeRedis {
      nodes(): { call: (c: string, ...a: (string | number)[]) => Promise<unknown> }[] {
        return [{ call: (c, ...a) => this.call(c, ...a) }];
      }
    }
    const fake = new ClusterFake();
    const client = new RedisClient(
      { host: 'h', port: 1, readOnly: true, cluster: { nodes: [{ host: '127.0.0.1', port: 6379 }] } },
      () => fake,
    );
    const nodes = client.nodes();
    expect(nodes).toHaveLength(1);
    await expect(nodes[0].call('SET', 'k', 'v')).rejects.toBeInstanceOf(RedisReadOnlyError);
    await expect(nodes[0].call('SCAN', 0)).resolves.toBeDefined();
  });

  it('Buffer 参数按原始值判定（<buffer:N> 占位符不再绕过子命令检查）', async () => {
    const { client, fake } = make({ readOnly: true });
    await expect(client.sendCommandBuffer('CONFIG', [Buffer.from('SET'), Buffer.from('a'), Buffer.from('b')]))
      .rejects.toBeInstanceOf(RedisReadOnlyError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('RedisClient 命令日志与脱敏', () => {
  it('非只读放行写命令并记录日志', async () => {
    const logs: RedisCommandLog[] = [];
    const { client, fake } = make({ onLog: (entry) => logs.push(entry) });
    await client.sendCommand('SET', ['k', 'v']);
    expect(fake.calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].command).toBe('SET');
    expect(logs[0].args).toEqual(['k', 'v']);
    expect(logs[0].ok).toBe(true);
    expect(logs[0].error).toBeUndefined();
    expect(logs[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('AUTH 参数不入日志（P7 §十）', async () => {
    const logs: RedisCommandLog[] = [];
    const { client } = make({ onLog: (entry) => logs.push(entry) });
    await client.sendCommand('AUTH', ['myuser', 'mypassword']);
    expect(logs).toHaveLength(1);
    expect(logs[0].args).toEqual(['<redacted>', '<redacted>']);
    expect(JSON.stringify(logs)).not.toContain('mypassword');
    expect(JSON.stringify(logs)).not.toContain('myuser');
  });

  it('CONFIG SET / ACL SETUSER 隐藏敏感值', async () => {
    const logs: RedisCommandLog[] = [];
    const { client } = make({ onLog: (entry) => logs.push(entry) });
    await client.sendCommand('CONFIG', ['SET', 'requirepass', 'hunter2']);
    await client.sendCommand('ACL', ['SETUSER', 'u', '>secretpass']);
    expect(logs[0].args).toEqual(['SET', '<redacted>', '<redacted>']);
    expect(logs[1].args).toEqual(['SETUSER', '<redacted>', '<redacted>']);
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    expect(JSON.stringify(logs)).not.toContain('secretpass');
  });

  it('普通命令参数逐项截断（防 keyspace dump）', async () => {
    const logs: RedisCommandLog[] = [];
    const { client } = make({ onLog: (entry) => logs.push(entry) });
    const long = 'x'.repeat(200);
    await client.sendCommand('SET', ['k', long]);
    expect(logs[0].args[0]).toBe('k');
    expect(logs[0].args[1].length).toBeLessThan(200);
    expect(logs[0].args[1].endsWith('…')).toBe(true);
  });

  it('redactCommandArgs：只读子命令与非敏感命令不误伤', () => {
    expect(redactCommandArgs('CONFIG', ['GET', 'maxmemory'])).toEqual(['GET', 'maxmemory']);
    expect(redactCommandArgs('ACL', ['LIST'])).toEqual(['LIST']);
    expect(redactCommandArgs('GET', ['key'])).toEqual(['key']);
    expect(redactCommandArgs('auth', ['p'])).toEqual(['<redacted>']);
  });

  it('命令失败也记录日志并抛出', async () => {
    const logs: RedisCommandLog[] = [];
    const { client, fake } = make({ onLog: (entry) => logs.push(entry) });
    fake.error = new Error('boom');
    await expect(client.sendCommand('GET', ['k'])).rejects.toThrow('boom');
    expect(logs).toHaveLength(1);
    expect(logs[0].ok).toBe(false);
    expect(logs[0].error).toContain('boom');
  });

  it('ping/info 走切面并被记录', async () => {
    const { client, fake } = make();
    await expect(client.ping()).resolves.toBe('OK');
    await expect(client.info('server')).resolves.toBe('OK');
    expect(fake.calls.map((c) => c.name)).toEqual(['PING', 'INFO']);
    expect(fake.calls[1].args).toEqual(['server']);
  });
});

describe('RedisClient close() 与状态', () => {
  it('isAlive 反映连接状态；close 幂等且置为 end', async () => {
    const { client, fake } = make();
    expect(client.isAlive()).toBe(true);
    await client.close();
    expect(fake.status).toBe('end');
    expect(fake.quitCalled).toBe(1);
    expect(client.isAlive()).toBe(false);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('未 ready（reconnecting）时直接 disconnect，不调用 quit', async () => {
    const { client, fake } = make();
    fake.status = 'reconnecting';
    await client.close();
    expect(fake.quitCalled).toBe(0);
    expect(fake.disconnectCalled).toBe(1);
    expect(fake.status).toBe('end');
  });

  it('SCAN/GET/SET/DEL/TTL 透传名字与参数', async () => {
    const { client, fake } = make();
    fake.reply = 'v';
    await client.sendCommand('SCAN', [0, 'MATCH', 'user:*', 'COUNT', 100]);
    await client.sendCommand('GET', ['k']);
    await client.sendCommand('SET', ['k', 'v']);
    await client.sendCommand('DEL', ['k1', 'k2']);
    await client.sendCommand('TTL', ['k']);
    expect(fake.calls).toEqual([
      { name: 'SCAN', args: ['0', 'MATCH', 'user:*', 'COUNT', '100'] },
      { name: 'GET', args: ['k'] },
      { name: 'SET', args: ['k', 'v'] },
      { name: 'DEL', args: ['k1', 'k2'] },
      { name: 'TTL', args: ['k'] },
    ]);
  });
});

describe('RedisClient 命令日志：多监听', () => {
  it('addLogListener 多监听与退订', async () => {
    const { client } = make();
    const a: RedisCommandLog[] = [];
    const b: RedisCommandLog[] = [];
    const offA = client.addLogListener((e) => a.push(e));
    client.addLogListener((e) => b.push(e));
    await client.sendCommand('GET', ['k']);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    offA();
    await client.sendCommand('GET', ['k']);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});

describe('RedisClient runExclusive（跨面板串行 SELECT+命令）', () => {
  it('按调用顺序串行执行，慢事务不被打断', async () => {
    const { client } = make();
    const order: string[] = [];
    const slow = client.runExclusive(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });
    const fast = client.runExclusive(async () => { order.push('b'); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});

describe('RedisClient 字节级命令（sendCommandBuffer）', () => {
  it('以 replyEncoding:null 提交并返回原始 Buffer，且走日志切面', async () => {
    const logs: RedisCommandLog[] = [];
    const { client, fake } = make({ onLog: (e) => logs.push(e) });
    const bytes = Buffer.from([0x00, 0xff, 0x41]);
    fake.reply = bytes;
    await expect(client.sendCommandBuffer('GET', ['k'])).resolves.toEqual(bytes);
    expect(fake.replyEncodings[0]).toBeNull();
    expect(fake.calls[0].name).toBe('GET');
    expect(logs).toHaveLength(1);
    expect(logs[0].ok).toBe(true);
  });

  it('只读模式按命令名拦截 SET buffer', async () => {
    const { client, fake } = make({ readOnly: true });
    await expect(client.sendCommandBuffer('SET', ['k', Buffer.from([1])])).rejects.toBeInstanceOf(RedisReadOnlyError);
    expect(fake.calls).toHaveLength(0);
  });

  it('Buffer 参数在日志中归一为 <buffer:N>，不灌二进制', async () => {
    const logs: RedisCommandLog[] = [];
    const { client } = make({ onLog: (e) => logs.push(e) });
    await client.sendCommandBuffer('SET', ['k', Buffer.from([0xff, 0x00])]);
    expect(logs[0].args).toEqual(['k', '<buffer:2>']);
  });
});
