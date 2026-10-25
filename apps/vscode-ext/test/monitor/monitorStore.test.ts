import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorStore } from '../../src/monitor/monitorStore';
import type { MonitorTask } from '../../src/monitor/monitorTypes';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'devbelt-monitor-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const task: MonitorTask = {
  id: 'm1', kind: 'rowCount', connId: 'c1', table: 'orders', intervalMs: 60_000,
  condition: { type: 'anyChange' }, status: 'paused', createdAt: 1, consecutiveFailures: 0,
};

describe('MonitorStore', () => {
  it('round-trips tasks and ignores malformed entries', async () => {
    const store = new MonitorStore(root);
    await store.saveTasks([task]);
    expect(await store.loadTasks()).toEqual([task]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(store.directory, 'tasks.json'), JSON.stringify([task, { id: '../x' }, { id: 'ok', kind: 'other' }]));
    expect(await store.loadTasks()).toEqual([task]);
  });

  it('writes files owner-only', async () => {
    const store = new MonitorStore(root);
    await store.saveTasks([task]);
    await store.appendPoint('m1', { at: 1, value: 1, durationMs: 1 });
    expect((await stat(join(store.directory, 'tasks.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(store.directory, 'm1.jsonl'))).mode & 0o777).toBe(0o600);
  });

  it('keeps only the newest points', async () => {
    const store = new MonitorStore(root, 5);
    for (let i = 0; i < 12; i++) await store.appendPoint('m1', { at: i, value: i, durationMs: 1 });
    const points = await store.readHistory('m1');
    expect(points.map((p) => p.at)).toEqual([7, 8, 9, 10, 11]);
    // A fresh store (cold cache) keeps trimming correctly.
    const reopened = new MonitorStore(root, 5);
    await reopened.appendPoint('m1', { at: 12, value: 12, durationMs: 1 });
    expect((await reopened.readHistory('m1')).map((p) => p.at)).toEqual([8, 9, 10, 11, 12]);
  });

  it('deletes history with the task and rejects unsafe ids', async () => {
    const store = new MonitorStore(root);
    await store.appendPoint('m1', { at: 1, value: 1, durationMs: 1 });
    await store.deleteHistory('m1');
    expect((await readdir(store.directory)).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
    await expect(store.appendPoint('../evil', { at: 1, durationMs: 1 })).rejects.toThrow(/invalid monitor task id/);
  });
});
