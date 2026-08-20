import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * 安全响应头配置（@fastify/helmet 的选项）。
 *
 * 单独成模块是为了让 createApp 与测试装配共用同一份值 —— 头部策略写在
 * app.ts 里的话，测试要么复制一遍（然后漂移），要么测不到。
 *
 * CSP 在这个项目里不是"加分项"：管理后台是 server 同源托管的 SPA，
 * admin token 存在 localStorage，而后台要渲染用户邮箱、设备名、连接名这些
 * 用户可控字符串。任何一处 XSS 都能直接读走一个 admin 的 token。
 * `script-src 'self'` 挡掉注入的 inline script 和外部脚本，也就挡掉了绝大
 * 多数把 token 外发出去的路径。
 */
export function securityHeaders(): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 后台产物是 vite 打出的外链 module script，不需要 inline 或 eval。
        // 这两个关键字一旦加上，CSP 对 XSS 的防护基本归零。
        scriptSrc: ["'self'"],
        /**
         * style 必须允许 inline。
         *
         * Vue 的 `v-show` 生成 `style="display:none"` 内联属性，CSP3 里在没有
         * 单独 style-src-attr 时由 style-src 兜住。收紧它会让后台的标签切换
         * 直接失效（所有面板同时显示）。这是有意识的妥协：style 注入的危害
         * 远小于 script 注入，且没有可行的替代（改掉 v-show 是另一回事）。
         */
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // 后台只请求自己的 API。允许 * 的话，XSS 拿到 token 后能直接外发
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // 点击劫持：后台的下拉框改 role、按钮吊销会话，被嵌进 iframe 诱导点击
        // 的代价很高。frame-ancestors 是现代浏览器的判据，X-Frame-Options 兜旧的
        frameAncestors: ["'none'"],
        /**
         * 显式禁用 helmet 默认的 upgrade-insecure-requests。
         *
         * 该指令会把页面里的 http 子资源（CSS/JS）强制升级成 https；本服务的
         * 生产部署是明文 http（443 被别的进程占用），升级后直接连接失败、后台
         * 白屏。TLS 属于部署层（nginx）的职责，不在应用侧强制。
         */
        upgradeInsecureRequests: null,
      },
    },
    /**
     * HSTS 由部署层（nginx）决定，应用侧不发。
     *
     * 应用不知道自己是否真在 HTTPS 后面：直连 HTTP 的开发/内网部署上发出
     * HSTS，会把访问过的浏览器锁死在一个连不通的 https 地址上，而 HSTS 的
     * max-age 在客户端，改回来只能等过期或让每个用户手工清。
     */
    hsts: false,
    /**
     * COEP 关掉：它要求所有跨源资源显式声明 CORP，而后台目前不需要
     * SharedArrayBuffer 这类必须跨源隔离的能力，开着只会造成难查的加载失败。
     */
    crossOriginEmbedderPolicy: false,
    /**
     * 静态资源要能被同源页面引用，用 same-origin 而不是默认的 same-origin
     * 更严格值即可；这里显式写出以免 helmet 默认值变动。
     */
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // 明确 DENY：frame-ancestors 之外给不支持 CSP3 的浏览器兜一层
    frameguard: { action: 'deny' },
    xssFilter: false,
  };
}
