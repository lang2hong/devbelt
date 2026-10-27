import { describe, expect, it } from 'vitest';
import { DOCS, DOC_GROUPS, renderDocsIndex, renderDocPage } from '../src/docs.js';

const NAV_ORDER = ['安装', '文档', 'GitHub', '功能', '套餐'];

describe('公开文档中心渲染', () => {
  it('文档首页按分组列出全部文档入口与说明', () => {
    const html = renderDocsIndex();
    expect(html).toContain('使用文档');
    for (const g of DOC_GROUPS) {
      expect(html).toContain(g.title);
      expect(html).toContain(g.desc);
    }
    for (const d of DOCS) {
      expect(html).toContain(`href="/db/docs/${d.slug}"`);
      expect(html).toContain(d.title);
      expect(html).toContain(d.summary);
    }
  });

  it('文档首页不再有左侧目录（全宽分组卡片）', () => {
    const html = renderDocsIndex();
    expect(html).not.toContain('<nav class="toc">');
    expect(html).toContain('<main class="docs">');
  });

  it('每篇文档渲染标题、小节、左侧目录与完整导航/页脚', () => {
    for (const d of DOCS) {
      const html = renderDocPage(d.slug) ?? '';
      expect(html).not.toBe('');
      expect(html).toContain(d.title);
      for (const s of d.sections) {
        expect(html).toContain(s.heading);
      }
      // 单篇保留左侧目录
      expect(html).toContain('<nav class="toc">');
      // 与首页一致的导航顺序
      const navStart = html.indexOf('<nav>');
      const navEnd = html.indexOf('</nav>', navStart);
      const nav = html.slice(navStart, navEnd);
      let cursor = -1;
      for (const label of NAV_ORDER) {
        const at = nav.indexOf(`>${label}<`);
        expect(at, `${d.slug} 缺少导航项 ${label}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      // 版本号不进导航
      expect(nav).not.toContain('0.4.0');
      // 四列页脚
      expect(html).toContain('VS Code Marketplace');
      expect(html).toContain('Open VSX');
      expect(html).toContain('v0.4.0 · MIT 许可');
      expect(html).toContain('href="/en"');
    }
  });

  it('header 感知登录态：未登录显示登录，已登录显示控制台', () => {
    const anon = renderDocsIndex();
    expect(anon).toContain('href="/login"');
    expect(anon).not.toContain('href="/db/">控制台');

    const authed = renderDocsIndex({ loggedIn: true });
    expect(authed).toContain('href="/db/">控制台');
    expect(authed).not.toContain('href="/login"');
  });

  it('文档配图使用本站真实截图，且不再有内联 SVG 插图', () => {
    const html = renderDocPage('getting-started');
    expect(html).toContain('/screenshots/01-sql-workbench.png');
    expect(html).toContain('<figure class="shot">');
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/width="1600" height="\d{3}"/);
    expect(html).not.toContain('<svg class="fig"');

    const all = DOCS.map((d) => renderDocPage(d.slug) ?? '').join('\n');
    expect(all).not.toContain('<svg class="fig"');
    for (const f of ['02-er-diagram-focus', '03-redis', '04-elasticsearch', '05-ai-chat-focus', '06-monitor-proposal', '07-monitor-tasks-focus', '08-explain-focus']) {
      expect(all).toContain(`/screenshots/${f}.png`);
    }
  });

  it('文档覆盖 v0.4.0 的全部产品能力（18 篇 / 6 组）', () => {
    expect(DOCS).toHaveLength(18);
    expect(DOC_GROUPS).toHaveLength(6);
    const slugs = DOCS.map((d) => d.slug);
    for (const s of [
      'getting-started', 'connections', 'sql', 'data', 'schema', 'insight',
      'redis', 'elasticsearch',
      'ai', 'monitoring', 'mcp',
      'security', 'masking',
      'backup', 'sync', 'account',
      'search', 'reference',
    ]) {
      expect(slugs).toContain(s);
    }
    const groupIds = new Set(DOC_GROUPS.map((g) => g.id));
    for (const d of DOCS) {
      expect(groupIds.has(d.group)).toBe(true);
      expect(d.sections.length).toBeGreaterThan(0);
      expect(d.icon.length).toBeLessThanOrEqual(2);
    }
  });

  it('0.4.0 与更早版本的关键能力都有落点', () => {
    expect(renderDocPage('monitoring')).toContain('多窗口');
    expect(renderDocPage('monitoring')).toContain('新增行');
    expect(renderDocPage('account')).toContain('账号数据隔离');
    expect(renderDocPage('insight')).toContain('EXPLAIN ANALYZE');
    expect(renderDocPage('insight')).toContain('allowAnalyzeProduction');
    expect(renderDocPage('redis')).toContain('XACK');
    expect(renderDocPage('ai')).toContain('Agent');
    expect(renderDocPage('ai')).toContain('includeSample');
    expect(renderDocPage('ai')).toContain('enableInlineCompletion');
    expect(renderDocPage('mcp')).toContain('MCP');
    expect(renderDocPage('mcp')).toContain('rateLimitPerMinute');
    expect(renderDocPage('masking')).toContain('.devbelt-mask.json');
    expect(renderDocPage('security')).toContain('TOTP');
    expect(renderDocPage('security')).toContain('known_hosts');
    expect(renderDocPage('backup')).toContain('定时备份');
    expect(renderDocPage('reference')).toContain('devbelt.redis.keyPageSize');
    expect(renderDocPage('reference')).toContain('1.85.0');
  });

  it('图标不与标题重复（SQL 编辑器用 ED）', () => {
    const sql = DOCS.find((d) => d.slug === 'sql');
    expect(sql?.icon).toBe('ED');
  });

  it('修掉了重复的 DevBelt 文案', () => {
    const index = renderDocsIndex();
    expect(index).not.toContain('DevBelt DevBelt');
    for (const d of DOCS) {
      expect(renderDocPage(d.slug)).not.toContain('DevBelt DevBelt');
    }
  });

  it('对标题/摘要做 HTML 转义（防注入）', () => {
    const index = renderDocsIndex();
    expect(index).not.toContain('<script>');
    const account = renderDocPage('account') ?? '';
    expect(account).toContain('&lt;base&gt;::u.&lt;userId&gt;');
  });

  it('未知 slug 返回 null（由路由决定 404）', () => {
    expect(renderDocPage('no-such-page')).toBeNull();
  });
});