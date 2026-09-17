/**
 * 套件首页（`/`）：devkit 入口落地页。
 *
 * 现阶段为轻量静态页，提供 DB 控制台与登录入口；待 `admin-ui` 落地后再加入后台链接。
 * 有意保持零构建依赖（内联 HTML），后续可替换为独立首页应用。
 */
export const HOME_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevBelt</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0b1020; color: #e6e9f2; }
      main { max-width: 640px; padding: 48px 32px; text-align: center; }
      h1 { font-size: 2.4rem; margin: 0 0 8px; letter-spacing: -0.02em; }
      p.sub { color: #9aa4bf; margin: 0 0 32px; }
      .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      a.card { display: block; padding: 20px; border: 1px solid #232a44; border-radius: 12px;
        background: #131a30; color: inherit; text-decoration: none; transition: border-color .15s, transform .15s; }
      a.card:hover { border-color: #3d6bff; transform: translateY(-2px); }
      a.card strong { display: block; font-size: 1.05rem; margin-bottom: 4px; }
      a.card span { color: #9aa4bf; font-size: .9rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>DevBelt</h1>
      <p class="sub">开发者工具套件</p>
      <div class="cards">
        <a class="card" href="/db/"><strong>DB 控制台</strong><span>连接、同步、套餐与组织</span></a>
        <a class="card" href="/login"><strong>登录</strong><span>进入你的账户</span></a>
      </div>
    </main>
  </body>
</html>`;