/**
 * 公开套餐页（`/plans`）SSR。
 *
 * 外壳（header/footer/tokens）来自 `publicChrome.ts`，与首页/文档中心一致。
 * 套餐数据由 Fastify 组合根从 billing 套餐目录读取后传入；缺省时降级为提示。
 */

import { renderPublicPage } from './publicChrome.js';

export interface HomePlan {
  code: string;
  name: string;
  kind: 'personal';
  priceCents: number;
  unit: 'month' | 'seat-month';
  /** 已格式化好的关键特性摘要。 */
  highlights: string[];
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(plan: HomePlan): string {
  if (plan.priceCents <= 0) return '免费';
  const yuan = plan.priceCents / 100;
  const amount = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return `¥${amount}`;
}

function formatUnit(plan: HomePlan): string {
  if (plan.priceCents <= 0) return '';
  return plan.unit === 'seat-month' ? '/席·月' : '/月';
}

function planCard(plan: HomePlan): string {
  const highlights = plan.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  const paid = plan.priceCents > 0;
  return `<article class="plan">
            <h3>${escapeHtml(plan.name)}</h3>
            <p class="price">${escapeHtml(formatPrice(plan))}<span>${escapeHtml(formatUnit(plan))}</span></p>
            <ul>${highlights}</ul>
            <a class="plan-cta" href="${paid ? '/login' : '/register'}">${paid ? '登录后升级' : '免费开始'}</a>
          </article>`;
}

const PLANS_CSS = `
      main.plans { padding: 40px 0 8px; }
      main.plans > .wrap > h1 { font-size: clamp(1.7rem, 3.2vw, 2.1rem); margin: 0 0 8px; letter-spacing: -0.02em; }
      main.plans .lead { color: var(--muted); margin: 0 0 32px; max-width: 760px; }
      .plans-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        max-width: 820px; }
      .plan { padding: 22px; border: 1px solid var(--line); border-radius: 14px;
        background: linear-gradient(180deg, var(--panel), var(--panel2)); display: flex; flex-direction: column; }
      .plan h3 { margin: 0 0 8px; font-size: 1.05rem; }
      .plan .price { font-size: 1.7rem; font-weight: 700; margin: 0 0 14px; letter-spacing: -0.02em; }
      .plan .price span { font-size: .85rem; font-weight: 400; color: var(--muted); margin-left: 4px; }
      .plan ul { list-style: none; padding: 0; margin: 0 0 18px; flex: 1; }
      .plan li { color: var(--muted); font-size: .92rem; padding: 3px 0 3px 18px; position: relative; }
      .plan li::before { content: ""; position: absolute; left: 0; top: 11px; width: 7px; height: 7px;
        border-radius: 2px; background: var(--accent); transform: rotate(45deg); }
      .plan-cta { text-align: center; padding: 10px 14px; border: 1px solid var(--line); border-radius: 9px;
        font-size: .92rem; color: var(--fg); }
      .plan-cta:hover { border-color: var(--accent); color: var(--accent2); text-decoration: none; }
      .empty { color: var(--muted); padding: 24px; border: 1px dashed var(--line); border-radius: 12px; }
      @media (max-width: 600px) { main.plans { padding: 28px 0 8px; } }
`;

/**
 * 公开套餐页（`/plans`）：无需登录。
 */
export function renderPlansPage(plans: HomePlan[] | null, opts: { loggedIn?: boolean } = {}): string {
  const personal = plans?.filter((p) => p.kind === 'personal') ?? [];
  const cards =
    personal.length > 0
      ? `<div class="plans-grid">${personal.map(planCard).join('\n          ')}</div>`
      : '<p class="empty">套餐信息暂时不可用，请稍后再试。</p>';

  const body = `<main class="plans">
      <div class="wrap">
        <h1>套餐</h1>
        <p class="lead">按需选择。连接与查询在你的设备上端到端加密后再同步，服务端只保存密文；配额以服务端校验为准。</p>
        ${cards}
      </div>
    </main>`;

  return renderPublicPage({
    title: '套餐 · DevBelt',
    description: 'DevBelt 个人套餐与配额。连接与查询端到端加密后同步，服务端只保存密文。',
    body,
    css: PLANS_CSS,
    chrome: { loggedIn: opts.loggedIn, active: 'plans' },
  });
}