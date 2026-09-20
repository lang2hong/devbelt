import type { ColumnMeta } from '../types/meta.js';

/**
 * Mock 数据取值（自 TableService 抽出，逐字搬移）。
 *
 * 纯函数：不触库；值是 SQL 字面量，字符串经调用方传入的方言转义器 `esc` 处理
 *（过去在方法内自建 `'${val.replace(/'/g,"''")}'`，漏掉反斜杠，MySQL 下数据不符）。
 */

/** 解析 enum/set 列的合法值 */
function parseEnum(type?: string): string[] {
  if (!type) return [];
  const m = type.match(/(?:enum|set)\s*\((.*)\)/i);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

function randomName(): string {
  const first = ['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Henry'];
  const last = ['Smith', 'Jones', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas'];
  return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
}

function randomCity(): string {
  const cities = ['New York', 'London', 'Tokyo', 'Paris', 'Berlin', 'Sydney', 'Toronto', 'Singapore', 'Shanghai', 'Mumbai'];
  return cities[Math.floor(Math.random() * cities.length)];
}

function randomAddress(): string {
  return `${Math.floor(Math.random() * 9999)} Main St, ${randomCity()}`;
}

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 按列名/类型生成 Mock 值（感知 enum 合法值与 varchar 长度）。 */
export function mockValue(col: ColumnMeta, seq: number, esc: (value: string) => string): string {
  const name = (col.name || '').toLowerCase();
  const type = (col.simpleType || col.type || '').toLowerCase();
  const fullType = col.type || '';
  const isNumeric = /int|bigint|serial|decimal|float|double|bool|bit/.test(type);
  const isTemporal = /date|time|year/.test(type);

  let val: string;
  const enumVals = parseEnum(fullType);
  if (enumVals.length) {
    val = enumVals[seq % enumVals.length];
  } else if (!isNumeric && name.includes('email')) {
    val = `user${seq}@example.com`;
  } else if (!isNumeric && (name.includes('phone') || name.includes('mobile'))) {
    val = `1${String(Math.floor(Math.random() * 9e9)).padStart(9, '0')}`;
  } else if (!isNumeric && name.includes('name')) {
    val = randomName();
  } else if (!isNumeric && name.includes('address')) {
    val = randomAddress();
  } else if (!isNumeric && name.includes('city')) {
    val = randomCity();
  } else if (!isNumeric && (name.includes('url') || name.includes('website'))) {
    val = `https://example.com/${seq}`;
  } else if (!isNumeric && (name.includes('avatar') || name.includes('image'))) {
    val = `https://example.com/avatar/${seq}.png`;
  } else if (!isNumeric && name.includes('password')) {
    val = randomString(12);
  } else if (!isNumeric && name.includes('token')) {
    val = randomString(32);
  } else if (!isNumeric && name.includes('ip')) {
    val = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  } else if (!isNumeric && name.includes('status')) {
    val = ['active', 'inactive', 'pending'][seq % 3];
  } else if (!isNumeric && name.includes('code')) {
    val = randomString(8).toUpperCase();
  } else if (!isNumeric && (name.includes('desc') || name.includes('content') || name.includes('comment'))) {
    val = `Mock data ${seq}`;
  } else if (type.includes('int') || type.includes('bigint') || type.includes('serial')) {
    val = String(seq + 1);
  } else if (type.includes('bool') || type.includes('bit')) {
    val = seq % 2 === 0 ? '1' : '0';
  } else if (type.includes('decimal') || type.includes('float') || type.includes('double')) {
    val = (Math.random() * 10000).toFixed(2);
  } else if (isTemporal) {
    const d = new Date(Date.now() - Math.floor(Math.random() * 365 * 86400000));
    val = d.toISOString().slice(0, 19).replace('T', ' ');
  } else if (type.includes('text') || type.includes('blob')) {
    val = `Mock ${seq}`;
  } else {
    val = randomString(10);
  }

  // 字符串类型按 varchar(N) 截断，避免 Data too long（text/blob/json 不限长）
  if (!isNumeric && !isTemporal && !/text|blob|json/i.test(type)) {
    const m = fullType.match(/\((\d+)\)/);
    let max = m ? parseInt(m[1], 10) : 0;
    if (max === 0 && /char/i.test(type)) max = 1; // char 无长度默认 1
    if (max > 0 && val.length > max) val = val.slice(0, max);
  }

  return isNumeric ? val : esc(val);
}