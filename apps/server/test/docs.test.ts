import { describe, expect, it } from 'vitest';
import { DOCS, renderDocsIndex, renderDocPage } from '../src/docs.js';

describe('公开文档中心渲染', () => {
  it('文档首页列出全部文档入口与说明', () => {
    const html = renderDocsIndex();
    expect(html).toContain('使用文档');
    for (const d of DOCS) {
      expect(html).toContain(`href="/db/docs/${d.slug}"`);
      expect(html).toContain(d.title);
      expect(html).toContain(d.summary);
    }
  });

  it('每篇文档渲染标题、小节与返回导航', () => {
    for (const d of DOCS) {
      const html = renderDocPage(d.slug);
      expect(html).not.toBeNull();
      expect(html).toContain(d.title);
      for (const s of d.sections) {
        expect(html).toContain(s.heading);
      }
      expect(html).toContain('href="/db/docs"');
      expect(html).toContain('href="/plans"');
      expect(html).toContain('href="/"');
    }
  });

  it('header 感知登录态：未登录显示登录，已登录显示控制台', () => {
    const anon = renderDocsIndex();
    expect(anon).toContain('href="/login"');
    expect(anon).not.toContain('href="/db/"');

    const authed = renderDocsIndex({ loggedIn: true });
    expect(authed).toContain('href="/db/"');
    expect(authed).not.toContain('href="/login"');
  });

  it('带插图的文档渲染内联 SVG', () => {
    const html = renderDocPage('getting-started');
    expect(html).toContain('<svg class="fig"');
    expect(html).toContain('role="img"');
  });

  it('未知 slug 返回 null（由路由决定 404）', () => {
    expect(renderDocPage('no-such-page')).toBeNull();
  });
});