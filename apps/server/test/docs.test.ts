import { describe, expect, it } from 'vitest';
import { DOCS, DOC_GROUPS, renderDocsIndex, renderDocPage } from '../src/docs.js';

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
      expect(html).toContain(d.icon);
    }
  });

  it('每篇文档渲染标题、小节与完整导航/页脚', () => {
    for (const d of DOCS) {
      const html = renderDocPage(d.slug);
      expect(html).not.toBeNull();
      expect(html).toContain(d.title);
      for (const s of d.sections) {
        expect(html).toContain(s.heading);
      }
      // 与官网一致的导航项
      expect(html).toContain('href="/db/docs"');
      expect(html).toContain('href="/plans"');
      expect(html).toContain('href="/"');
      expect(html).toContain('href="/#install"');
      expect(html).toContain('https://github.com/lang2hong/devbelt');
      expect(html).toContain('href="/en"');
      // 与官网一致的四列页脚
      expect(html).toContain('VS Code Marketplace');
      expect(html).toContain('Open VSX');
      expect(html).toContain('v0.4.0 · MIT 许可');
    }
  });

  it('header 感知登录态：未登录显示登录/注册，已登录显示控制台', () => {
    const anon = renderDocsIndex();
    expect(anon).toContain('href="/login"');
    expect(anon).toContain('免费注册');
    expect(anon).not.toContain('href="/db/"');

    const authed = renderDocsIndex({ loggedIn: true });
    expect(authed).toContain('href="/db/"');
    expect(authed).not.toContain('href="/login"');
  });

  it('文档配图使用本站真实截图，且不再有内联 SVG 插图', () => {
    const html = renderDocPage('getting-started');
    expect(html).toContain('/screenshots/01-sql-workbench.png');
    expect(html).toContain('<figure class="shot">');
    expect(html).toContain('loading="lazy"');
    // 宽高必须写出，避免布局跳动
    expect(html).toMatch(/width="1600" height="9\d\d"/);
    expect(html).not.toContain('<svg class="fig"');

    const all = DOCS.map((d) => renderDocPage(d.slug) ?? '').join('\n');
    expect(all).not.toContain('<svg class="fig"');
    expect(all).toContain('/screenshots/03-redis.png');
    expect(all).toContain('/screenshots/04-elasticsearch.png');
    expect(all).toContain('/screenshots/05-ai-chat.png');
    expect(all).toContain('/screenshots/06-monitor-proposal.png');
    expect(all).toContain('/screenshots/07-monitor-tasks.png');
    expect(all).toContain('/screenshots/08-explain.png');
  });

  it('文档覆盖官网展示的全部产品能力', () => {
    const slugs = DOCS.map((d) => d.slug);
    for (const s of ['getting-started', 'connections', 'sql', 'data', 'schema', 'insight', 'redis', 'elasticsearch', 'ai', 'monitoring', 'sync', 'account']) {
      expect(slugs).toContain(s);
    }
    // 每篇都属于一个已知分组
    const groupIds = new Set(DOC_GROUPS.map((g) => g.id));
    for (const d of DOCS) expect(groupIds.has(d.group)).toBe(true);
  });

  it('0.4.0 关键内容出现在对应文档里', () => {
    expect(renderDocPage('monitoring')).toContain('多窗口');
    expect(renderDocPage('monitoring')).toContain('新增行');
    expect(renderDocPage('account')).toContain('账号数据隔离');
    expect(renderDocPage('insight')).toContain('索引建议');
    expect(renderDocPage('redis')).toContain('XACK');
    expect(renderDocPage('ai')).toContain('Agent');
  });

  it('修掉了重复的 DevBelt 文案', () => {
    const index = renderDocsIndex();
    expect(index).not.toContain('DevBelt DevBelt');
    for (const d of DOCS) {
      expect(renderDocPage(d.slug)).not.toContain('DevBelt DevBelt');
    }
  });

  it('对标题/摘要做 HTML 转义（防注入）', () => {
    // 静态内容本身可信，但渲染层必须转义；正文里的尖括号以实体形式出现
    const index = renderDocsIndex();
    expect(index).not.toContain('<script>');
    const account = renderDocPage('account') ?? '';
    expect(account).toContain('&lt;base&gt;::u.&lt;userId&gt;');
  });

  it('未知 slug 返回 null（由路由决定 404）', () => {
    expect(renderDocPage('no-such-page')).toBeNull();
  });
});