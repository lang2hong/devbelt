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
