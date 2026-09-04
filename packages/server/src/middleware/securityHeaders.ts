import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * 安全响应头配置（@fastify/helmet 的选项）。
 *
 * 单独成模块是为了让 createApp 与测试装配共用同一份值 —— 头部策略写在
 * app.ts 里的话，测试要么复制一遍（然后漂移），要么测不到。
 *
 * 当前服务端只提供 JSON API，未托管任何前端产物。这份 CSP 仍按"未来会在
 * 同源托管管理后台"设定：`script-src 'self'` 挡掉注入的 inline script 与外部
 * 脚本，`connect-src 'self'` 阻断把凭据外发的路径。管理后台的目标形态见
 * docs/archive/管理后台架构.md；真正挂载静态资源时需连同这里一起复核。
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
         * style 允许 inline：常见前端框架（含 Vue 的 `v-show`）会写
         * `style="display:none"` 这类内联属性，CSP3 里在没有单独 style-src-attr
         * 时由 style-src 兜住。这是有意识的妥协 —— style 注入的危害远小于
         * script 注入。
         */
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // 后台只请求自己的 API。允许 * 的话，XSS 拿到 token 后能直接外发
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // 点击劫持：管理界面会改角色、吊销会话，被嵌进 iframe 诱导点击的代价很高。
        // frame-ancestors 是现代浏览器的判据，X-Frame-Options 兜旧的
        frameAncestors: ["'none'"],
        /**
         * 显式禁用 helmet 默认的 upgrade-insecure-requests。
         *
         * 该指令会把页面里的 http 子资源强制升级成 https。应用不知道自己是否
         * 真在 TLS 后面（本地开发与内网部署可能是明文 http），升级后子资源直接
         * 连接失败。TLS 由部署层（反向代理）终止，不在应用侧强制。
         */
        upgradeInsecureRequests: null,
      },
    },
    /**
     * HSTS 由部署层（反向代理）决定，应用侧不发。
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
