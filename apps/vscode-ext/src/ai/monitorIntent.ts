/**
 * 监控意图识别：用户直接说「监控某表每分钟新增行数」时要走 Agent 模式
 * （只有 Agent 才有 `propose_monitor`），普通问答会回答「做不到」。
 *
 * 保守匹配：只认明确的监控/定时措辞，避免把「监控一下这条 SQL 的性能」也误判
 * （那类请求开 Agent 也不影响结果，只是多花一次工具调用）。
 */
const PATTERNS: RegExp[] = [
  /监控/,
  /后台任务/,
  /新增行/,
  /定时(检查|监控|查询|统计)/,
  /每\s*\d+\s*(秒钟?|分钟|小时).{0,12}(检查|监控|统计|提醒|看)/,
  /\bmonitor\b/i,
  /\bwatch\b[^.]{0,40}\b(new )?(rows?|data|events?)\b/i,
  /\bcheck\b[^.]{0,20}\bevery\b[^.]{0,10}\b(minute|second|hour)s?\b/i,
];

export function wantsMonitorTask(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return PATTERNS.some((re) => re.test(value));
}