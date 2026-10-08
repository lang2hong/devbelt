import { describe, expect, it } from 'vitest';
import {
  adminCMD,
  allCommandNames,
  commandCompletions,
  isAdminWriteCommand,
  isDangerousCommand,
  isWriteCommand,
  readCMD,
  writeCMD,
} from '../../src/redis/redisCommands';

describe('Redis 命令表分类（移植 ARDM v1.1.1 + DevBelt 加强）', () => {
  it('修正 ARDM 分类错误：BITOP 归入 writeCMD', () => {
    expect(Object.prototype.hasOwnProperty.call(writeCMD, 'BITOP')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(readCMD, 'BITOP')).toBe(false);
    expect(isWriteCommand('BITOP')).toBe(true);
    expect(isWriteCommand('bitop')).toBe(true);
  });

  it('基础读写分类', () => {
    expect(isWriteCommand('SET')).toBe(true);
    expect(isWriteCommand('DEL')).toBe(true);
    expect(isWriteCommand('HSET')).toBe(true);
    expect(isWriteCommand('GET')).toBe(false);
    expect(isWriteCommand('SCAN')).toBe(false);
    expect(isWriteCommand('INFO')).toBe(false);
    expect(isWriteCommand('TTL')).toBe(false);
  });

  it('admin 写 denylist（ARDM 只读模式会漏掉这批）', () => {
    for (const cmd of [
      'SHUTDOWN', 'DEBUG', 'FAILOVER', 'REPLICAOF', 'SLAVEOF', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'MONITOR',
    ]) {
      expect(isWriteCommand(cmd)).toBe(true);
      expect(isAdminWriteCommand(cmd)).toBe(true);
    }
    expect(isWriteCommand('CONFIG', ['SET', 'maxmemory', '1gb'])).toBe(true);
    expect(isWriteCommand('CONFIG', ['REWRITE'])).toBe(true);
    expect(isWriteCommand('CONFIG', ['RESETSTAT'])).toBe(true);
    expect(isWriteCommand('ACL', ['SETUSER', 'u'])).toBe(true);
    expect(isWriteCommand('ACL', ['DELUSER', 'u'])).toBe(true);
    expect(isWriteCommand('ACL', ['LOAD'])).toBe(true);
    expect(isWriteCommand('ACL', ['SAVE'])).toBe(true);
    expect(isWriteCommand('MODULE', ['LOAD', '/x.so'])).toBe(true);
    expect(isWriteCommand('MODULE', ['UNLOAD', 'x'])).toBe(true);
    expect(isWriteCommand('CLIENT', ['KILL', 'ID', '1'])).toBe(true);
  });

  it('admin 只读子命令不被误拦', () => {
    expect(isWriteCommand('CONFIG', ['GET', 'maxmemory'])).toBe(false);
    expect(isWriteCommand('ACL', ['GETUSER', 'u'])).toBe(false);
    expect(isWriteCommand('ACL', ['LIST'])).toBe(false);
    expect(isWriteCommand('ACL', ['WHOAMI'])).toBe(false);
    expect(isWriteCommand('CLIENT', ['LIST'])).toBe(false);
    expect(isWriteCommand('MODULE', ['LIST'])).toBe(false);
    expect(isWriteCommand('CLUSTER', ['INFO'])).toBe(false);
    expect(isWriteCommand('LATENCY', ['LATEST'])).toBe(false);
  });

  it('admin/read/write 三表均导出且非空', () => {
    expect(Object.keys(adminCMD).length).toBeGreaterThan(10);
    expect(Object.keys(readCMD).length).toBeGreaterThan(50);
    expect(Object.keys(writeCMD).length).toBeGreaterThan(50);
  });

  it('危险命令判定', () => {
    expect(isDangerousCommand('FLUSHALL')).toBe(true);
    expect(isDangerousCommand('FLUSHDB')).toBe(true);
    expect(isDangerousCommand('SHUTDOWN')).toBe(true);
    expect(isDangerousCommand('KEYS', ['*'])).toBe(false);
    expect(isDangerousCommand('KEYS')).toBe(false);
    expect(isDangerousCommand('CONFIG', ['SET', 'x', 'y'])).toBe(true);
    expect(isDangerousCommand('CONFIG', ['REWRITE'])).toBe(true);
    expect(isDangerousCommand('CONFIG', ['GET', 'x'])).toBe(false);
    expect(isDangerousCommand('GET')).toBe(false);
  });

  it('H4：危险命令扩展覆盖（停机/复制/脚本/调试/迁移等）', () => {
    for (const c of [
      'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'SYNC', 'PSYNC',
      'EVAL', 'EVALSHA', 'FAILOVER', 'REPLICAOF', 'SLAVEOF', 'MONITOR',
      'MIGRATE', 'SWAPDB',
    ]) {
      expect(isDangerousCommand(c), c).toBe(true);
    }
    // DEBUG 只确认破坏/阻塞子命令；RESTORE 是正常数据恢复，不弹确认。
    expect(isDangerousCommand('DEBUG', ['SEGFAULT'])).toBe(true);
    expect(isDangerousCommand('DEBUG', ['SLEEP', '1'])).toBe(true);
    expect(isDangerousCommand('DEBUG', ['OBJECT', 'k'])).toBe(false);
    expect(isDangerousCommand('RESTORE', ['k', '0', 'x'])).toBe(false);
    expect(isDangerousCommand('SCRIPT', ['KILL'])).toBe(true);
    expect(isDangerousCommand('SCRIPT', ['FLUSH'])).toBe(true);
    expect(isDangerousCommand('SCRIPT', ['EXISTS', 'a'])).toBe(false);
    expect(isDangerousCommand('SCRIPT', ['LOAD', 'x'])).toBe(false);
    expect(isDangerousCommand('FUNCTION', ['LOAD', 'x'])).toBe(true);
    expect(isDangerousCommand('CLIENT', ['KILL', 'ID', '1'])).toBe(true);
    expect(isDangerousCommand('ACL', ['SETUSER', 'u'])).toBe(true);
    expect(isDangerousCommand('MODULE', ['LOAD', 'x'])).toBe(true);
    // CLIENT PAUSE 属写命令
    expect(isWriteCommand('CLIENT', ['PAUSE', '100'])).toBe(true);
    // 复制/握手类归写（此前 isReadCommand 也 false，属分类缺口）
    expect(isWriteCommand('SYNC')).toBe(true);
    expect(isWriteCommand('PSYNC')).toBe(true);
    expect(isWriteCommand('REPLCONF')).toBe(true);
  });

  it('补全候选按前缀过滤、大小写不敏感', () => {
    const names = allCommandNames();
    expect(names).toContain('GET');
    expect(names).toContain('BITOP');
    const s = commandCompletions('se');
    expect(s).toContain('SET');
    expect(s.every((n) => n.startsWith('SE'))).toBe(true);
    expect(commandCompletions('get')).toEqual(['GET', 'GETBIT', 'GETDEL', 'GETRANGE', 'GETSET']);
    expect(commandCompletions('')).toEqual(names);
  });
});
