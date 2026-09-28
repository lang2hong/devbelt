# P5 — 2FA / TOTP 验证器

> 状态：draft v9 final（根据第四轮交付评审修正：协议文件真实路径、secretCache key 与
> onDidChange 的解析对齐、IPC `null`/`undefined` 序列化、pendingAction 防丢消息、S2/S3
> 视图按钮范围收口、secretCache 异步预热契约、TagColorKey 类型落地、文案与缓存说明
> 对齐），达到可直接交付实施标准。
> 本文档先讲清楚「这个阶段要做的产品是什么、给谁用、怎么用」，技术实现放在最后供开发评审。

## 一、这个阶段要做什么

给 DevBelt 加一个**动态口令验证器**。

你在很多网站和服务上开启两步验证时，对方会给你一张二维码或一串密钥。现在你得再装一个
手机 App 去存它、显示 6 位动态口令。这个阶段，我们把这件事做进 DevBelt：**把密钥存进
DevBelt，打开「验证器」面板就能看到此刻的 6 位口令，用来登录。**

就像 Microsoft Authenticator、腾讯身份验证器，但是长在 DevBelt 里。装好扩展、不用登录也
能用；支持分组、标签、搜索、复制、导出。

一句话：**DevBelt 里多一个「验证器」工具——可从命令面板/命令打开面板，并已加入侧边栏「工具」视图列表首项（`devbelt.tools[0] = devbelt.authenticator`）。**

## 二、用户能做什么

- **添加**：粘贴 `otpauth://totp/...` 链接，或手动输入（发行方 issuer、账号、secret、算法、位数、周期）。
  **不做摄像头扫码**（VS Code 扩展没有摄像头 API）、**不做** Google Authenticator 的
  `otpauth-migration` protobuf 导入。允许 issuer + account 完全相同的重复条目（内部以
  uniqueId 区分，对齐 Google/Microsoft Authenticator 行为），不做联合唯一约束——用户有
  多个同站点账号时可能手动添加多次。
- **查看**：「验证器」webview 面板，每个条目显示发行方、账号、6 位口令、倒计时圈；
  分组可折叠，顶部有搜索框和标签筛选。
- **分组**：一级分组（不嵌套），可新建/重命名/删除/排序；**无"未分组"、无默认分组**——
  每个验证码必须属于某个分组。新建分组用**模态对话框**（重命名/在上方/下方插入仍用内联输入条）；
  工具栏「＋新增验证码」旁有「＋新建分组」，添加/编辑表单的分组选择为**必填**（未选保存禁用），
  表单内可直接新建分组并自动选中。历史无分组或孤儿 `groupId` 的条目由 store `.init()` 自愈归入
  **第一个分组**（一个分组都没有时留待建第一个分组时归入）。**删分组会级联删除组内验证码**
  （含其 SecretStorage 密钥），二次确认显示将一并删除的条数。
- **标签**：给条目打一个或多个彩色标签；标签是扁平的，不分组；面板顶部可以按标签筛选；
  标签颜色从**8 色固定调色板**里选，不做自定义色值。调色板 key 固定为：
  `blue / green / yellow / orange / red / purple / cyan / gray`（前端 Vue 样式和 Store 校验
  都按这 8 个 key 对齐，不存 hex）。
- **复制**：点条目复制口令到剪贴板（**不承诺自动清空**——VS Code 只能写剪贴板，跨平台可靠
  清空做不到，不骗用户）；复制后卡片有短暂"已复制"视觉反馈；倒计时剩余 ≤5 秒时卡片用颜色
  警告"即将刷新"，避免用户复制到 1 秒后就失效的码；复制到剪贴板的是纯 6/8 位数字（如 `123456`，
  不含空格、不加分隔符）。
- **搜索**：按 issuer/account 模糊搜索；输入框在顶部。
- **编辑/删除**：条目可改 issuer/account/分组/标签/算法/位数/period；secret 在编辑时留空（
  字段为空串或字段缺省）表示**保留原 secret**，填了非空值才替换；**不存在"清空 secret 但保留
  条目"的操作**，要换 secret 必须提供新值；提交前会严格校验 base32，不合法在表单内联报错。
- **导出**：导出为每行一个 `otpauth://totp/...` 的纯文本文件，明文导出弹 modal 警告（必须
  用 `vscode.window.showWarningMessage(..., { modal: true }, '导出')` 并检查返回值）；导出
  的 secret 统一为大写、无空格、无 padding 的 base32，保证跨 app 最大兼容；**不做加密
  导出**（没有主口令）。
- **导入**：粘贴单个 `otpauth://totp/...` 链接（UI 上一次加一个）；解析前先 `trim()` 并
  去除常见零宽字符（`\u200B\u200C\u200D\uFEFF`），避免从聊天工具复制来的链接解析失败；
  不做批量文件导入。粘贴链接 / 导入二维码图片**不直接入库**：宿主解析后只下发非密文字段 +
  一次性 `prefillId`，打开**预填添加表单**，选/新建分组后再按 `prefillId` 合并宿主暂存的 secret
  入库（secret 始终不下发 webview）。

不做：
- 不做摄像头扫码（VS Code 无摄像头 API）、不做 `otpauth-migration` 批量二维码导入；单条二维码**图片**录入**已交付**（粘贴/拖拽/选择，见文末）。
- 不做分组嵌套。
- 不做 DevBelt 自己登录的二次验证（那是另一件事）。
- 不做网页版、不做团队共享、不做多设备同步（同步留给 P5 之后的增量）。
- 不做「剪贴板自动清空」。
- 不做时钟偏差校正（RFC 6238 T0=0，直接用 `Date.now()`；UI 空态/提示里告知用户"请确保
  系统时钟准确"，跨 period 边界不对时用户能自行排查）。
- 不做批量文件导入。

## 三、为什么值得做

- 开发者的密码、密钥、动态口令散落在各种工具里。验证器是第一个**和数据库无关**的工具，也是
  DevBelt 从「一个数据库插件」走向「多种工具共用一套账号底座」的起点。
- 高频刚需；打开即看、一点即复；分组和标签让条目多了也不乱。
- 本地可用、无账号门槛；条数套餐字段先埋好，以后同步上线时自然带上付费升级点。

## 四、怎么用（走一遍）

1. 命令面板执行「验证器」命令（或点「＋ 添加」命令）→ 打开**验证器 webview 面板**（不占用活动栏图标）。
2. 顶部：搜索框 + 标签筛选条 + 「＋ 添加」「从图片添加」「导出」按钮。
3. 中间：分组折叠区，每个分组下是条目卡片，卡片上：发行方 / 账号 / 彩色标签 / 6 位大字口令 /
   倒计时圈；点卡片复制口令；点卡片右上「⋯」有编辑/删除菜单项。
4. 点「＋ 添加」：面板内就地弹一个小表单（同一个 webview 内，不开新窗口），粘贴
   otpauth 链接/二维码图片或手动填写，保存即加入列表。

装上就能用，不要求登录、不要求主口令。

## 五、安全（用大白话）

- 密钥（secret）**持久化只存在**你自己电脑的操作系统密钥库里（Windows 凭据管理器 /
  macOS Keychain / Linux secret-service——就是 VS Code 的 SecretStorage，和 DevBelt 现有
  的刷新令牌存在同一个地方）。扩展主进程运行期会把 secret 缓存在 Extension
  Host 内存（`secretCache`）里供每秒 TOTP 计算使用，但 secret 永远不会进入 webview、
  不会写入 globalState、不会写日志。
- 界面上**只显示 6 位口令，不显示 secret 本身**。编辑时 secret 字段默认留空，要改请重填。
- **我们的服务器永远看不到你的密钥**——本阶段不联网；以后做同步时密钥也会在本地用主口令密
  钥加密成密文再上传。
- 面板（webview）**拿不到 secret**，只从扩展主进程收到「口令 + 剩余秒」。secret 不进
  postMessage 载荷、不下发、不缓存。
- 明文导出弹 modal 警告；secret 不写日志、不写错误栈、不进 telemetry。

## 六、怎么算做好了

- **算法正确性**：RFC 6238 Appendix B 八组 8 位 SHA1 官方向量 + SHA256/SHA512 各一组向量（三
  算法种子长度不同，见测试章节）全绿；覆盖 6/8 位、30/60 秒组合；base32 解码正确处理空
  白/大小写/缺 padding，非法字母严格拒绝；otpauth URI 解析/生成 roundtrip 幂等。
- **功能**：添加（粘贴/手动/二维码图片，均经预填表单选分组）、分组（增删改/折叠/删组级联删验证码）、
  标签（多标签/筛选/选色/删除）、搜索、编辑、删除、复制、导出 URI——全部可用；验证码必属分组。
- **安全边界**：secret 只落 SecretStorage、不下发 webview、不进日志/错误消息。
- **工程**：`pnpm typecheck && pnpm lint && pnpm test` 全绿；webview 构建通过；`pnpm -C apps/vscode-ext package` 打 VSIX 成功。
- **国际化**：中/英双语（命令、按钮、空态、错误文案都走 i18n）。

## 七、交付切片（P5 内部，按顺序、每个切片可单独跑）

- **S1 · 算法和存储层跑通（纯后端，无 UI）**：纯 TOTP/base32/otpauth 函数 + SecretStorage/Memento
  存储层（含内存 secretCache）+ 完整 Vitest 单元测试（算法向量、store CRUD、容错、quota
  判定、canonicalizeSecret 归一化）。**不**改 `package.json` 的 `commands`/`menus`，
  **不**实现任何 UI——S1 不向最终用户暴露任何 UI，只在 `out/extension.js` 里就绪算法和 store
  能力。这一切片**可单独 merge**，合入后不影响现有功能。
- **S2 · webview 面板主框架**：以 `BaseWebView` 实现**验证器 webview 面板**（`viewType`
  `devbelt.authenticator`）——**后续变更**：新增侧边栏「工具」webview 视图 `devbelt.tools`
  （`views.devbelt` 第二项；首项工具 = 验证器）；仍复用同一面板逻辑。仅注册
  一个命令 `devbelt.authenticator`（打开/聚焦面板），**不**在 S2 注册 `devbelt.authenticator.add`
  / `.export`；面板内实现两阶段握手、每秒 tick（单条 tick 消息）、copy、错误边界、pending
  action 队列；webview 端 `AuthenticatorView.vue` 基础列表渲染（平铺 issuer/account/
  code/倒计时 + 复制反馈，无添加/分组/标签/搜索）。完成后用户可经命令打开面板看到已有条目
  与实时口令、点卡片复制。
- **S3 · 分组、标签、搜索、增删改、导出**：注册 `devbelt.authenticator.add` / `.export`
  两个命令（供命令面板/快捷键；面板内也有「＋」「图片」「导出」按钮）；分组树折叠/增删改
  排序、条目增/编/删表单、标签添加/筛选/选色、顶部搜索框（debounce，任意结果集本地排序）、
  导出文件（CRLF、modal 警告、主进程 showSaveDialog+写文件）、二维码**图片**录入（粘贴/拖拽/
  选择）、粘贴 otpauth 链接（**后续变更**：解析后走预填表单、secret 留宿主按 `prefillId` 合并；
  **无未分组**、分组必填、删组级联、新建分组改用模态对话框）、超限预检（达上限直接弹升级不展开
  表单）、折叠/展开通过 toggleGroup 消息驱动、copyOk 反馈、formError 内联错误。
- **S4 · 收尾**：i18n 中/英（命令、按钮、空态、错误文案、升级提示都走 catalog，NLS key
  五个）、三种空态（未添加/搜索无结果/分组下无条目）、删除/导出的 modal/非 modal 确认、
  `pnpm -C apps/vscode-ext package` 打 VSIX 验证。

P5 四个切片加起来就是"本地好用"。切片之间不跨期、不跨分支，按顺序往 `feat/2FA-TOTP-authenticator`
分支合。

**P5 之后的未来增量**（不在本阶段）：多设备同步（authenticator 作为第 5/6 种
同步实体接入 E2EE）、网页版、团队共享、同步内核
namespace 化重构、批量导入。这些不排期、不承诺。

## 八、套餐与条数

新增 personal plan feature key：

- key：`maxAuthenticatorEntries`
- 类型：number
- 默认值（seed 到迁移里）：**free = 10，pro = 1000**
- 语义：用户可保存的验证器条目上限。

客户端行为：
- **未登录**（无网络、无账号）：不做本地条数上限——本地存储是 OS 级的，没有付费墙的意义，
  限了也是绕得过的假限制。
- **登录态**：`AuthenticatorStore.add()` 前读 `entitlement.maxAuthenticatorEntries`，超限弹
  提示升级 Pro；已经存在的条目（历史/降级后）不删除、继续可见、可复制、可导出，只是禁止新增。
- **超限预检 UX**：已达上限时，用户点击面板内「＋」按钮（或命令面板「添加条目」）
  `devbelt.authenticator.add`，**直接弹升级提示**（带「升级 Pro」按钮打开套餐面板），
  不要展开空添加表单让用户填完后再报错——表单白填是坏 UX。只有当前条目数 < 上限时才
  向 webview 发 `openAddForm` 打开表单。
- 服务端暂时不需要按这个 key 强校验（因为 P5 不做同步，服务端根本看不到这些条目）；未来做
  同步时再在 sync push 时按条数拒绝超限新增（和现有 `maxConnectionMetas` 的总条数校验并列）。

这个 feature key 在 P5 里只是**加字段 + 客户端登录态提示**；服务端迁移 seed 值也一并加好，
未来同步上线时服务端直接可用。

---

## 附：实现要点（给开发评审用，产品同学可跳过）

### 命令注册与 contributes

package.json `contributes` 改动分两批：

**S2 引入（打开面板命令）：**
- `commands` 新增**一个**（category 继续用 `"DB Client"`，不新开分类）：
  - `devbelt.authenticator` — i18n `cmd.authenticator` = `"Authenticator"` / `"验证器"`，
    handler 打开/聚焦「验证器」webview 面板（`AuthenticatorView.open(store)`）。
- **后续变更**：新增 `views.devbelt` 的 `devbelt.tools`（webview，工具列表，首项 = 验证器）；容器与活动栏图标沿用既有 `devbelt`，未新增容器。
- `menus.commandPalette`：`devbelt.authenticator` 直接可见。

**S3 引入（增/导命令）：**
- `commands` 再新增两个：
  - `devbelt.authenticator.add` — i18n `cmd.authenticator.add` = `"Add Entry"` / `"添加条目"`。
    handler 逻辑：先判 quota（登录态已达上限 → 直接弹升级、不打开面板表单）；未超限则
    `AuthenticatorView.openAddForm(store)`（打开/聚焦面板；面板未 ready 时置 pendingAction，
    第二次 ready 后补发 `openAddForm`）。面板内也有「＋」按钮走同一路径。
  - `devbelt.authenticator.export` — 导出；handler 直接调 `store.exportAll()` +
    `vscode.window.showSaveDialog` 写文件（主进程直接处理文件 IO，不下发文件内容给 webview，
    不依赖面板是否 ready）。面板内「导出」按钮走同一实现。
- **不加** `menus.view/title`（已无侧边栏视图）。
- `menus.commandPalette`：`devbelt.authenticator.add` / `devbelt.authenticator.export`
  设 `"when": "false"`（只走面板按钮/内部调用，不进面板）。

命令注册走 `makeSub(context)`（沿用 `commands/shared.ts` 统一错误处理），新增
`registerAuthenticatorCommands(deps: Deps, sub: Sub)`，和其它 register* 函数一样签名，
在 `commands.ts` 聚合器里调用。

接入需要改两个地方：
1. `apps/vscode-ext/src/commands/shared.ts` 的 `Deps` 接口加一个字段：
   `authStore: AuthenticatorStore`（authenticator 存储实例）。
2. `apps/vscode-ext/src/extension.ts` 构造 Deps 字面量处把 `authStore` 传进去；并订阅
   `AuthenticatorChangedEvent → AuthenticatorView.refreshCurrent()`。

i18n：`package.nls.json` / `package.nls.zh-cn.json` 加 `cmd.authenticator`、
`cmd.authenticator.add`、`cmd.authenticator.export`（3 个 key；不再有视图相关 key）。
扩展主进程提示走 catalog（`authenticator.*` 前缀，含 `authenticator.title`），webview 文案走
catalog（`wv.authenticator.*` 前缀），和现有 catalog 前缀约定保持一致。

### Webview 面板（BaseWebView 子类）

验证器**不是**侧边栏视图，而是与 Query/Design 等一致的 **`WebviewPanel`**：以现有
`BaseWebView` 为基类实现 `AuthenticatorView`（放
`apps/vscode-ext/src/authenticator/authenticatorView.ts`），复用其面板创建、HTML 注入、
`onDidReceiveMessage`/`onDidDispose`、`post`（自动注入 `isZh`）、错误边界与「两次 ready」
`__load` 重置。要点：

- **构造签名**：`private constructor(store: AuthenticatorStore) → super('devbelt.authenticator', l10n('authenticator.title'))`。
  `extensionUri` 由 `BaseWebView.init(context.extensionUri)` 在 `extension.ts` 统一提供，无需外部读取。
- **单例打开/聚焦**：`static open(store)` 首次 `new`、已存在则 `panel.reveal(ViewColumn.Active)`；
  `static openAddForm(store)` 打开并请求表单；`static refreshCurrent()` 供事件订阅刷新。
- **外部命令入口**：`requestAddForm()`（供命令调用）：先在主进程 `store.checkQuota()`，
  达上限弹升级、不展开表单；否则若已 `initSent` 直接 `post({type:'openAddForm'})`，
  否则设 `pendingAction='openAddForm'` 待第二次 ready 补发。对外 `refresh(): Promise<void>`
  供 EventBus 订阅调用。
- **面板生命周期**：由 `BaseWebView` 统一处理——构造时 `createWebviewPanel` + `getWebviewHtml`，
  订阅 `onDidReceiveMessage`（含 `__load` 变化即重置 `initSent`）与 `onDidDispose`（清 timer、
  清单例）。`retainContextWhenHidden:true`（BaseWebView 默认）→ 面板隐藏后仍存活、tick 持续；
  关闭（`onDispose`）清理。
- **两阶段 ready**：第一次 ready → `initSent=true; post({type:'init', mode:'authenticator'})`
  （`isZh` 由 `BaseWebView.post` 自动注入）；第二次 ready（App.vue 切到 AuthenticatorView 后）
  → `sendSnapshot()` + 起 tick timer + 消费 `pendingAction`。
- **接入顺序（extension.ts）**：`BaseWebView.init(extensionUri)`（其它面板已调用）→ 构造
  `AuthenticatorStore` → **`await store.init()`**（secretCache 预热）→ `registerCommands`
  （Deps 含 `authStore`）→ 订阅 `AuthenticatorChangedEvent → AuthenticatorView.refreshCurrent()`。
  面板**按需打开**（命令触发），激活时不预建；`activationEvents` 仍为 `onStartupFinished`。
- **定时器**：`tick()` 遍历未折叠条目，计算 `{code, secondsLeft}`，合并为**一条**
  `{type:'tick', nowMs, codes}` 下发（不逐条）；折叠组不计算/不下发，组展开瞬间补发该组
  codes。`setInterval(tick, 1000)` 在第二次 ready 启动，`onDispose` 清除。
- **post 守卫**：`BaseWebView` 已保证面板销毁后不再调用；`onDispose` 同时清 timer 与单例。
- **外部刷新入口**：提供 `refresh(): Promise<void>` 方法（extension.ts 在收到
  `AuthenticatorChangedEvent` 时调用），内部重新 listEntries 并 post 快照给 webview。
  快照下发前做 IPC 规范化：`groupId === undefined` → `null`（对齐下行协议）；entry id
  在 `store.missingSecrets` 里时附带 `error: 'secretMissing'` 让 UI 显示灰色错误态。
- **消息错误边界**：handleMessage 外层包 try/catch，失败走 `diagError('authenticator
  message handler', String(e))` 并尝试 `post({type:'error', message})`（与 BaseWebView
  baseWebView.ts:42-49 等价），避免未捕获异常打坏监听器。
- **动作白名单（上行：webview → 主进程）**：webview 发来的消息走 switch，只允许
  `ready | add | update | delete | addGroup | updateGroup | deleteGroup | moveEntry |
  reorderGroup | addTag | removeTag | toggleGroup | export | copy` 这几种；不接受任意命令
  字符串（仿 AccountHubView 的 `ACTION_COMMANDS` 思路，但用 switch 显式分支而非 Set）。
  `toggleGroup` 消息携带 `{ groupId, folded: boolean }`，主进程更新内存中的折叠状态（折叠态只
  在主进程内存里维护，不落 memento——重启后默认展开），影响下一次 tick 计算哪些 codes 需
  要下发。
- **下行消息（主进程 → webview）类型集合**：`init | snapshot | tick | copyOk | formError |
  error | openAddForm`，完整 Payload 见下方"Webview 消息协议"章节。
- **复制**：webview 发送 `{type:'copy', code, entryId}` 消息（字段对齐协议定义），主进程校验
  code 是纯 6/8 位数字字符串后调 `vscode.env.clipboard.writeText(code)`，webview 不直接
  访问 clipboard API；写成功后回 `{type:'copyOk', entryId}` 让 webview 显示"已复制"反馈。
- **添
加/编辑/条数超限**：主进程 handler 收到 `add`/`update` 等动作后，**先做入站规范化**：
  把消息 payload 里 `groupId: null` 转为 `undefined`，空串 `''` 也转 `undefined`，再传给
  store 方法；store 返回
  `Promise<{ ok: true } | { ok: false; reason: 'quota'|'invalidSecret'|... }>` 结果对象，
  不抛业务错误（避免被 makeSub 兜底成通用"命令失败"对话框）。handler 根据 result.reason
  用 i18n 文案弹对应提示：`quota` → `showInformationMessage` + 「升级 Pro」按钮调
  `vscode.commands.executeCommand('devbelt.plans')`；`invalidSecret` 等用户输入错误 →
  回 `{type:'formError', field:'secret', message:'...'}` 让 webview 内联显示。
- **添加/编辑表单**：同一个 webview 内用 Vue 状态切换（如 `showAddForm: boolean`、`editingId`），
  不另开 WebviewPanel，不新建 HTML 入口。

### Webview 前端（Vue 3）

沿用现有单一 vite 构建，加以下内容：

- `apps/vscode-ext/src/result/protocol.ts` 的 `WebviewMode` 联合加 `'authenticator'`（
  协议类型也加在同一个文件，见下方"Webview 消息协议"章节）；webview 侧继续通过相对路径
  `../../src/result/protocol` 导入（对齐 App.vue:5 现有模式，**不要**在 webview/src 下新建
  `result/protocol.ts`，会导致两份类型漂移）。
- `webview/src/App.vue` 的 `v-else-if` 链加一个分支渲染 AuthenticatorView。
  **用 `defineAsyncComponent` 动态导入**（`const AuthenticatorView = defineAsyncComponent(() => import('./views/AuthenticatorView.vue'))`），
  让 Vite 把 AuthenticatorView 打到 `chunks/AuthenticatorView.js` 分片，仅在
  `mode === 'authenticator'` 时按需加载——所有现有 panel（query/design/er/status/...）
  共用的 `index.js` 主 bundle 不会因为 authenticator 视图变大。
- 新建 `webview/src/views/AuthenticatorView.vue`：
  - 顶部：搜索框（v-model 过滤 issuer/account/tag，100–150ms debounce）+ 标签筛选条（彩色
    chip，点击切换筛选）+ 「＋ 添加」「导出」按钮；
  - 中部：分组列表，每个分组可折叠（点击分组名折叠/展开，折叠态不渲染条目卡片也不收
    tick codes，节省主进程与 IPC），分组标题行带「重命名」「删除」「在上方/下方新建分组」
    操作；
  - 分组内：条目卡片（issuer / account / 标签 / 大号 code / 倒计时 SVG 圈），卡片点一下
    post `copy`，右上「⋯」菜单有编辑/删除；code 显示纯数字（如 `123456`，无空格/分隔符）；
    倒计时 secondsLeft ≤5 秒时卡片变红色/警告态提示即将刷新；
  - 添加/编辑：就地展开一个表单行（不弹窗），字段：issuer、account、secret（password 类型
    输入框，`autocomplete="off" autocapitalize="off" spellcheck="false"`，禁止浏览器自动
    填充）、algorithm 下拉（SHA1/SHA256/SHA512）、digits 下拉（6/8）、period 下拉（30/60）、
    分组下拉、标签多选（已有标签 chip 勾选项 + 「新建标签」输入）；编辑态 secret 字段默认
    留空，用户填写了非空值才替换；提交前本地先做 base32 格式校验，不合法直接内联报错，
    不提交到主进程；
  - 空态：未添加任何条目/搜索无结果/分组下无条目三种空态分别提示；"未添加"空态里提一句
    "请确保系统时钟准确，口令会在 30/60 秒后刷新"。
- 复用 `useVsCode.ts`、`useI18n.ts`，不引入新依赖；倒计时用主进程 tick 消息里的 `nowMs`
  和 `secondsLeft` 驱动 SVG 圈（本地可用 requestAnimationFrame 平滑补间），但 **code 切换
  以主进程 tick 消息为唯一权威**，webview 端不自行跑 TOTP 算法。消息协议仿 protocol.ts
  的 discriminated union 风格为 add/update/delete/tick/copyOk/entries 等定义类型，避免
  `msg:any`。

### Webview 消息协议（双向 discriminated union，强类型约束）

协议类型集中定义在 `apps/vscode-ext/src/result/protocol.ts`（和现有 WebviewInitMessage/
WebviewReadyMessage 同文件——注意：**不在 webview 下建 `result/protocol.ts`**，仓库里
不存在那个路径；现有 webview 通过相对路径 `../../src/result/protocol` 导入同一文件，
见 webview/src/App.vue:5）。所有消息都继承 `WebviewMessage`（带 `type: string`），
webview 发出的消息由 useVsCode.ts 自动附加 `__load`。

**IPC 边界的 `null` vs `undefined` 约定**：TypeScript/JSON 序列化会丢失对象上值为
`undefined` 的字段，跨进程消息里**凡是"未分组/无目标/不存在"语义一律用 `null`**；
主进程收到后在写入 Store 前规范化为 JavaScript 语义的 `undefined`（Store 持久化模型里
`groupId?: string` 保持 optional），避免 postMessage 丢字段导致的歧义。snapshot 下发时
也把 `undefined` 归一化为 `null`。
（**后续变更**：验证器不再有「未分组」——新增/编辑必须带有效 `groupId`，`null`/`undefined` 仅作为
历史过渡态由 store 自愈归入第一个分组；`moveEntry`/`toggleGroup` 的 `null` 已无实际用途。
粘贴链接/扫码改为「宿主暂存 secret + 下发 `prefillAdd`，表单提交带 `prefillId`」。）

**上行消息（Webview → Extension Host，主进程在 provider.handleMessage 里 switch 分发）：**

```ts
export type AuthenticatorUpMessage =
  // 两阶段握手（和 BaseWebView 一致）
  | { type: 'ready'; __load?: string }
  // 条目增删改
  | { type: 'add'; entry: {
      issuer: string; account?: string; secret: string;       // secret 是用户原始输入，主进程 canonicalize
      algorithm: TotpAlgorithm; digits: 6|8; period: 30|60;
      groupId: string | null; tags: string[];               // 必填有效分组；历史 null 由 store 自愈
    }; prefillId?: string }                                  // 预填表单：secret 由宿主按此 id 补齐
  | { type: 'update'; id: string; patch: {
      issuer?: string; account?: string; secret?: string;    // secret 缺省或空串 => 保留原 secret
      algorithm?: TotpAlgorithm; digits?: 6|8; period?: 30|60;
      groupId?: string | null; tags?: string[];              // 必填有效分组；历史 null 由 store 自愈
    } }
  | { type: 'delete'; id: string }
  // 分组
  | { type: 'addGroup'; name: string; afterId?: string }
  | { type: 'updateGroup'; id: string; name: string }
  | { type: 'deleteGroup'; id: string }
  | { type: 'moveEntry'; id: string; targetGroupId: string | null } // null => 未分组（必填，不用 ?）
  | { type: 'reorderGroup'; orderedGroupIds: string[] }       // 拖拽后完整 id 顺序
  // 标签
  | { type: 'addTag'; name: string; color: TagColorKey }     // TagColorKey = 'blue'|...|'gray'
  | { type: 'removeTag'; id: string }
  // UI 状态
  | { type: 'toggleGroup'; groupId: string | null; folded: boolean } // null => 折叠/展开「未分组」区
  // 动作
  | { type: 'copy'; code: string; entryId: string }          // 复制到剪贴板（主进程校验 code 格式）
  | { type: 'export' };                                      // webview 内"导出"按钮（S3 引入，主进程 showSaveDialog+写文件）
```

**下行消息（Extension Host → Webview，webview 的 onMessage 按 type 分发）：**

```ts
export type AuthenticatorDownMessage =
  // 两阶段握手
  | { type: 'init'; mode: 'authenticator'; isZh: boolean }
  // 快照（第二 ready 后、AuthenticatorChangedEvent 后、或 refresh() 调用时整量下发）
  | { type: 'snapshot';
      entries: Array<Omit<AuthenticatorEntry, 'groupId'> & { groupId: string | null; error?: 'secretMissing' }>;
      groups: AuthenticatorGroup[];
      tags: AuthenticatorTag[];
    }
  // 每秒 tick（只包含未折叠组的 codes，折叠组的 entry 不在 codes 里）
  | { type: 'tick'; nowMs: number; codes: Record<string, { code: string; secondsLeft: number }> }
  // 复制反馈
  | { type: 'copyOk'; entryId: string }
  // 表单内联错误
  | { type: 'formError'; field?: string; message: string }  // field 为空 => 顶部提示
  // 打开添加表单（由外部命令或超限恢复后触发；S3 引入）
  | { type: 'openAddForm' }
  // 通用错误（兜底）
  | { type: 'error'; message: string };
```

**实现约束**：
- 主进程的 `post(msg)` 对消息做 `JSON.parse(JSON.stringify(msg))` 的代理拷贝已被
  `useVsCode.post` 自动处理（webview 端），主进程直接 `webview.postMessage(msg)` 即可。
- 上下行消息里**绝对不**出现 secret 字段；下行 `snapshot` 里的 `entries` 类型就是
  `AuthenticatorEntry`（天然不含 secret）。
- 所有动作消息（add/update/...）的返回结果不通过 reply message 回传：store 返回
  `{ ok:true }` 时主进程 publish AuthenticatorChangedEvent 触发新 snapshot 下发；返回
  `{ ok:false, reason }` 时主进程回 `formError`。这种"单向命令 + 事件驱动快照刷新"的模式
  对齐现有 BaseWebView 的 update 流程，避免为每个动作定义单独的 ok/error reply。

### 存储（对齐 ConnectionStore 模式）

globalState 键（使用 `context.globalState`——**不要**用 `workspaceState`，条目要跨项目
持久化；workspaceState 随项目切换丢失）：
- `devbelt.authenticator.entries`：`AuthenticatorEntry[]`（不含 secret）
- `devbelt.authenticator.groups`：`AuthenticatorGroup[]`
- `devbelt.authenticator.tags`：`AuthenticatorTag[]`（可选，也可以从 entries 里聚合出来，但
  独立存更利于改名/换色）

SecretStorage 键：
- `devbelt.authenticator.<id>.secret`：单个条目的 secret，存储形态为**重新编码后的大写、
  无空格、无 padding 的 RFC 4648 §6 base32 字符串**（SecretStorage 只接 string；之所以不
  存解码后的原始字节，是因为字符串往返更稳；之所以选"无 padding、大写、无空格"的规范
  形态，是为了让 add→list→export→import roundtrip 不产生差异）。
- **规范化函数 `canonicalizeSecret(input: string): string`**（addEntry 和 otpauth URI
  解析都必须先经此函数归一化，禁止把用户原始输入直接存起来）：
  1. `const stripped = input.replace(/\s+/g, '')`（剥掉所有 JavaScript `\s` 空白——空格/制表/
     换行/全角空格/零宽空格，含粘贴带入的常见空白；与 base32 字母表无关的零宽字符如
     `\u200B\u200C\u200D\uFEFF` 已在 URI 解析入口通过 trim+去除零宽预处理，若仍残留此
     处会因 base32 解码拒绝而抛错）；
  2. `const bytes = decodeBase32Loose(stripped)`（容错大小写/末尾缺失 padding，非法字
     母抛错）；
  3. `return encodeBase32UpperCaseNoPadding(bytes)`（重新编码为大写、无 padding 的
     规范形态，作为存储与导出的统一形式）。

类型定义（放 `apps/vscode-ext/src/authenticator/types.ts`）：
```ts
export type TotpAlgorithm = 'SHA1'|'SHA256'|'SHA512';

/** 标签调色板 8 色 key（前端样式映射 + Store 白名单校验共用）。不存 hex。 */
export const AUTHENTICATOR_TAG_COLORS = [
  'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'cyan', 'gray',
] as const;
export type TagColorKey = typeof AUTHENTICATOR_TAG_COLORS[number];

/** 用户自定义分组。无"默认/未分组"分组：验证码必须属于某个分组，UI 不渲染未分组区；
 *  历史无分组/孤儿 groupId 的条目由 store.init() 自愈归入第一个分组。
 *  （持久化模型仍允许 groupId === undefined 作为过渡态；IPC 边界 null 由主进程规范化为 undefined。） */
export type AuthenticatorGroup = {
  id: string;           // uniqueId('ag')
  name: string;
  sortOrder: number;
};

export type AuthenticatorTag = {
  id: string;           // uniqueId('at')
  name: string;
  color: TagColorKey;   // 8 色 key 之一，Store 校验白名单
};

export type AuthenticatorEntry = {
  id: string;           // uniqueId('ae')  —— entry 前缀用 'ae'，给未来同步实体留 'a'
  issuer: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: 6|8;
  period: 30|60;
  groupId?: string;     // 指向 groups[].id；新增/编辑表单必填，UI 无「未分组」回落；
                        // 历史 undefined/孤儿值由 store 自愈归入第一个分组
  tags: string[];       // tag id 数组
  createTime: number;
  updateTime: number;
};
// secret 不在 entry 里，单独 SecretStorage
```

`AuthenticatorStore` 类（放 `authenticator/store.ts`）：
- 构造注入：
  - `secrets: vscode.SecretStorage`（来自 `context.secrets`）；
  - `memento: vscode.Memento`（来自 `context.globalState`，不要 workspaceState）；
  - `auth: { isLoggedIn(): boolean; getCachedEntitlement(): CachedEntitlement | undefined }`
    （注入 `AuthService` 实例，现场读取登录态与权益——**不要**在构造时拍一份 entitlement
    snapshot，否则登录/登出/套餐变更后 quota 永远是旧值）。
- **SecretStorage key 辅助函数（集中维护前缀一致性）**：
  ```ts
  const SECRET_KEY_PREFIX = 'devbelt.authenticator.';
  const SECRET_KEY_SUFFIX = '.secret';
  function secretKey(id: string): string {
    return `${SECRET_KEY_PREFIX}${id}${SECRET_KEY_SUFFIX}`;
  }
  /** 从 SecretStorage key 反解 entry id；不匹配前缀时返回 null。 */
  function parseSecretKey(key: string): string | null {
    if (!key.startsWith(SECRET_KEY_PREFIX) || !key.endsWith(SECRET_KEY_SUFFIX)) return null;
    return key.slice(SECRET_KEY_PREFIX.length, key.length - SECRET_KEY_SUFFIX.length) || null;
  }
  ```
  所有 secrets 读写都必须走 `secretKey(id)` 拼接，**禁止**直接字符串模板拼 key，避免与
  onDidChange 解析不一致。
- **secret 内存缓存（性能关键，对齐 ConnectionStore.secretCache）**：
  - 维护 `private readonly secretCache = new Map<string, string>()`（id → 规范化后的
    大写无 padding base32 字符串）。
  - **`getCodes(entryIds, nowMs)` 计算 TOTP code 时必须从 `secretCache` 读，禁止直接调用
    `secrets.get()`**——VS Code 的 SecretStorage 底层是 OS Keychain（macOS Keychain /
    Linux SecretService / Windows Credential Manager），每次访问都是 IPC/系统调用。每
    秒对几十条条目逐一打 OS Keychain 会造成扩展宿主 CPU 飙升、系统安全守护进程过载。
  - **异步预热契约**：对外暴露 `async init(): Promise<void>`。在 extension.ts activate
    里必须 `await store.init()` 后再构造 provider/registerCommands。init() 实现：从
    memento 读 entries 列表 → 遍历批量调 `secrets.get(secretKey(id))` 填充 secretCache，
    找不到的 id 记录到内存 `missingSecrets: Set<string>` 供 snapshot 下发
    `error:'secretMissing'`（UI 灰色条显示"该条目密钥丢失，建议删除后重新添加"），**不**
    抛异常中断激活；init 完成后再允许 UI 显示。
  - `addEntry`：在 secret 成功写入 `secrets.store(secretKey(id), canonicalSecret)` 之后，
    同步 `secretCache.set(id, canonicalSecret)` 并从 missingSecrets 移除。
  - `updateEntry`：如果 patch 里带了新 secret，secrets.store 成功后更新 cache；不带
    secret 不动 cache。
  - `deleteEntry(id)`：**事务顺序——先删 secret、成功后再改 memento**（避免 orphan
    secret）：先 `await secrets.delete(secretKey(id))`；抛错则中止并返回
    `{ ok:false, reason:'storageError' }`，memento 不动；成功后 `secretCache.delete(id)`、
    `missingSecrets.delete(id)`、从 entries 数组移除、`memento.update` 写回。
  - `clearAll()`：容错循环——遍历 entries 逐个
    `secrets.delete(secretKey(id))`，成功的从 secretCache 和 entries 列表移除，失败的
    收集到 remaining 列表保留（下次重试），最后写回 memento。
  - `secrets.onDidChange` 回调（跨窗口变更同步）：**必须**先用 `parseSecretKey(e.key)`
    校验前缀并解析 id；返回 null 的 key（不属于 authenticator 命名空间）直接忽略；
    解析成功后按 `e.key` 调 `secrets.get(e.key)`，`undefined` → `secretCache.delete(id)`
    + `missingSecrets.add(id)`；有值 → `secretCache.set(id, value)` + `missingSecrets.delete(id)`；
    然后 publish 一次 AuthenticatorChangedEvent 让 UI 刷新（对齐 ConnectionStore 的
    hostEvents 处理，connectionStore.ts:129-134）。**不要**直接拿 `e.key` 做 cache key——
    cache key 是 entry id，不是 SecretStorage 完整路径，否则跨窗口更新会在 cache 里产生
    以 `devbelt.authenticator.xxx.secret` 为名的脏条目，getCodes 永远读不到。
- 方法：`listEntries()`/`listGroups()`/`listTags()`/`getSecret(id)`（从 cache 读，不走 IPC；
  cache 未初始化完成时抛 `new Error('store not initialized')`）/
  `addEntry(input)`/`updateEntry(id,patch)`/`deleteEntry(id)`（事务顺序见上；所有入站
  IPC 消息里的 `groupId: null` 在写入 Store 之前规范化为 `undefined`；groupId 为
  空串 `''` 时也视为无分组（历史过渡态，由 init/建组自愈归入第一个分组））/
  `addGroup(name,afterId?)`（新组 sortOrder = `Math.max(...groups.map(g => g.sortOrder), 0) + 10`，
  留空隙方便以后 drag 重排）/`renameGroup(id,name)`（空名视为非法，返回 formError）/
  `deleteGroup(id)`（**级联删除**组内 entry 及其 secret；secret 删除失败的条目不置墓碑、
  清 groupId 交给自愈，避免 orphan secret）/
  `addTag(name,color)`（color 必须是 `AUTHENTICATOR_TAG_COLORS` 白名单值，非白名单值拒绝）/
  `renameTag/deleteTag`（删 tag 时从所有 entry.tags 里移除）/
  `reorderGroup(orderedGroupIds)`（按传入 id 顺序把 groups 的 sortOrder 重写为
  `10, 20, 30, ...`，避免只改相邻 group 的 sortOrder 留下重叠/空洞）/
  `exportAll(): string`（返回 otpauth URI 按行拼接的文本，CRLF 换行，secret 统一大写无空格无
  padding）/`clearAll()`（见上）；
  tick 计算暴露 `getCodes(entryIds: string[], nowMs: number): Record<string,{code,secondsLeft}>`
  方法供 provider 调用——此方法**只从 secretCache 读**，不触碰 secrets API；cache miss
  的 id 不出现在返回结果里（snapshot 里已标 error:'secretMissing'，UI 不应期待它们有
  code）。
- **变更通知通道（对齐 ConnectionStore + EventBus 模式）**：
  - 定义 `AuthenticatorChangedEvent extends AppEvent`（放 `authenticator/events.ts`），
    字段最小化：`{ kind: 'entry'|'group'|'tag', operation: 'create'|'update'|'delete', id: string }`，
    不传完整对象（provider 自己重新 list 即可）。
  - 所有写操作（add/update/delete/addGroup/.../clearAll）成功后调
    `eventBus.publish(new AuthenticatorChangedEvent(kind, operation, id))`（复用
    `packages/db-host/src/utils/event.ts` 的全局 eventBus 单例，和 ConnectionChangedEvent
    等保持一致）。
  - `extension.ts` 里订阅 `AuthenticatorChangedEvent`，调 `authViewProvider.refresh()`
    推最新快照给 webview（和 ConnectionChangedEvent → treeProvider.refresh() 的接法一致
    ，见 extension.ts:94-104）。**不要**让 provider 直接 import store 的 EventEmitter。
  - store 仍订阅 `secrets.onDidChange`，但目的是**多窗口 secret 变更同步**（对齐
    ConnectionStore 的 `hostEvents` 用法）：回调里只更新 store 内部可能存在的缓存（如
    果有），然后 publish 一次 AuthenticatorChangedEvent，而不是直接通知 provider。
- 实现 `Disposable`：清理 `secrets.onDidChange` 订阅（以及如果用了内部 EventEmitter 也清
  理）；dispose 时清订阅、清内存缓存。push 到 `context.subscriptions`
  （在 provider 之前 push，反序 dispose 时 provider 先销毁）。
- 条目 ID 用 `uniqueId('ae')`（entry 前缀 `'ae'`；导入路径：
  `import { uniqueId } from '@devbelt/db-host/utils/id'`，对齐 auditLogger.ts:3、
  connectionForm.ts:9 的用法——不要加 `.ts`/`.js` 后缀）；group 前缀 `'ag'`，tag 前缀 `'at'`。
- 条数校验在 `addEntry` 里：
  - 先读 `this.auth.isLoggedIn()` 和 `this.auth.getCachedEntitlement()`；
  - **未登录** → 不限条数（本地存储是 OS 级的，做付费墙没意义）；
  - **已登录** → 调 `maxAuthenticatorEntries(entitlement)`（fail-closed 默认 10），若
    当前 entries 数量 ≥ 上限则**返回** `{ ok: false, reason: 'quota', limit }`——**不要抛
    错**（现有 `atConnectionCap()` 在 commands/connection.ts:46-49 也是直接在 handler 里
    弹提示不抛错；store 层抛业务错会被 `makeSub` 兜底成通用"命令失败"对话框，丢失"升级
    Pro"的定制按钮）；正常成功返回 `{ ok: true }`。其它用户输入错误（invalidSecret、
    invalidUri 等）同样用 `{ ok:false, reason, field? }` 返回。
  - 已存在的条目（历史/降级后）不删除、继续可见、可复制、可导出，只是禁止新增。

### 算法（零第三方依赖，纯 node:crypto，不 import vscode）

位置：`apps/vscode-ext/src/authenticator/totp.ts`、`base32.ts`，纯函数，不 import vscode，方便
未来抽到共享包。

- **base32**：RFC 4648 §6（A–Z、2–7、`=` padding）实现两个编解码入口配合规范化函数使用：
  - `decodeBase32Loose(s): Uint8Array`：解码容错范围**仅限三类**：(a) 忽略 ASCII 空白
    （空格/制表/换行）；(b) 大小写不敏感（内部转大写）；(c) 末尾缺失 padding 自动补齐。
    除此以外的字符（包括 `0189` 等视觉易混字符、Unicode 全角字母、零宽字符等）一律视
    为非法抛错——**不**做"尽力解码"或跳过非法字符，避免 secret 被静默错解。
  - `encodeBase32UpperCaseNoPadding(bytes): string`：编码输出大写、无 padding 的 base32
    字符串，作为存储与导出的统一规范形态。
  （项目现只有 base64url，没有 base32，需要新写。）
- **HOTP**（RFC 4226）：`HMAC(secret, 8-byte big-endian counter)` → dynamic truncation 取 31bit
  → `mod 10^digits`，左侧 pad 0 到 digits 位。用 `crypto.createHmac(algo, secret)`。
- **TOTP**（RFC 6238）：`counter = Math.floor((nowMs/1000) / period)`，T0=0；时钟源用
  `Date.now()`（系统时钟，不做偏差校正）；返回 `{code, secondsLeft}`
  （`secondsLeft = period - Math.floor(nowMs/1000) % period`，用于 UI 倒计时）。
- **otpauth URI**（RFC 现无强制标准，按 Google Authenticator 事实约定实现）：
  - 解析前先 `trim()` 并去除零宽字符（`\u200B\u200C\u200D\uFEFF`），再丢给 `new URL(uri)`。
  - 解析 `otpauth://totp/<label>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30`。
  - `label` 先 `decodeURIComponent`，再按**第一个** `:` 拆成 `issuerFromLabel` 和 `account`
    （只切一次，避免 account 里含冒号时被切坏）：
    - 含冒号 → `{ issuerFromLabel, account }`；
    - 不含冒号 → `{ issuerFromLabel: '', account: label }`；
    - query 参数里的 `issuer` 优先于 `issuerFromLabel`，两者都没有时 issuer 取空串
      （UI 显示时显示 account 即可，不强制要求 issuer）。
  - secret 参数走 `canonicalizeSecret()` 归一化；解码失败直接拒绝。
  - 只接受协议 `totp`，`hotp` 直接拒绝。
  - 生成（导出用）：secret 已经是规范化形态，直接拼：
    - `encIssuer = encodeURIComponent(issuer)`；
    - `encAccount = encodeURIComponent(account ?? '')`；
    - account 非空时 `label = encIssuer + ':' + encAccount`；account 为空时 `label = encIssuer`
      （**不**生成带冒号的空 account）；
    - 拼接：`otpauth://totp/${label}?secret=${normSecret}&issuer=${encIssuer}&algorithm=${algo}&digits=${digits}&period=${period}`；
    - 算法/位数/周期是默认值（SHA1/6/30）时仍显式写出（和主流 app 行为一致）。
- 默认值：算法 SHA1、位数 6、周期 30；URI/输入显式指定时用显式值。

### 测试（vitest，零新配置）

- 新文件 `apps/vscode-ext/test/authenticator/totp.test.ts`：
  - RFC 6238 Appendix B 八组 SHA1 测试向量（T=59/1111111109/1111111111/.../20000000000，
    seed = ASCII `"12345678901234567890"`（20 字节，刚好是 SHA1 块长），8 位）。
  - SHA256 向量：seed = ASCII `"12345678901234567890123456789012"`（**32** 字节，不是 20）；
    SHA512 向量：seed = ASCII `"1234567890123456789012345678901234567890123456789012345678901234"`
    （**64** 字节，不是 20）—— 三个算法种子长度不同，不要用同一个 20 字节种子跑三算法，
    否则向量不过。
  - 6/8 位、30/60 秒组合。
  - base32：空串、有无 padding、大小写、含空白、非法字符（0/1/8/9/全角/零宽）、非法字
    母严格拒绝。
  - otpauth 解析：带/不带 issuer、带 algorithm/digits/period、hotp 拒绝、缺 secret 拒绝、
    URL 编码的中文/特殊字符 issuer、account 含冒号、account 为空、前后空白/零宽字符。
  - otpauth 生成：parse→build roundtrip 幂等；导出的 secret 大写无空格无 padding。
- `apps/vscode-ext/test/authenticator/store.test.ts`：
  - 用 in-memory Memento/SecretStorage 测试桩（**参考 `packages/db-host/test/connectionStoreCache.test.ts:4-23`**
    的 `memento()` + `secretsWithEvents()`：前者是 Map -backed Memento stub（`get`/`update`），
    后者是带 `onDidChange(listener)` + `emit(key)` helper 的 in-memory SecretStorage，能
    触发跨窗口变更回调。不要参考 `host.test.ts`——那个 secrets stub 没有 onDidChange
    实现，也没有 memento stub，覆盖不到 AuthenticatorStore 的 secrets 订阅路径）。
  - add/update/delete/getSecret；
  - `store.init()` 预热后 secretCache 完整；`getCodes()` 不调用 `secrets.get`（用 vi.spyOn 断言）；
  - secret 写入/删除成功后 cache 同步更新；secrets.delete 失败时不修改 memento 与 cache（事务顺序）；
  - `secrets.onDidChange` 回调：非 `devbelt.authenticator.` 前缀的 key 忽略；合法前缀正确
    解析 id 并刷新 cache/缺失集合（不要用完整 SecretStorage key 作为 cache key）；
  - 删除分组时**级联删除**组内条目及其 secret（逐条 publish）；首次 init 与建第一个分组时
    把无分组/孤儿条目自愈归入第一个分组；
  - 删除标签时从条目 tags 数组移除；
  - 未登录态 add 不限条数；登录态达上限返回 `{ ok:false, reason:'quota' }`；降级到 free 后已有
    条目保留且不自动删除；
  - IPC 入站 `groupId: null` / `''` 规范化为 `undefined`；
  - secret 经过 canonicalizeSecret 归一化后再存储；otpauth 输入与手动输入走同一归一化路径；
  - `reorderGroup` 后 sortOrder 被重写为 `10,20,30...`；
  - `addTag` 对非白名单 color 拒绝；
  - clearAll 容错：某个 key delete 抛错时，其它已成功删除的条目从 memento 移除，失败的
    条目保留在列表里（不丢 memento 索引，下次可重试），不产生 orphan secret；
  - store 未 init() 时调 getSecret/getCodes 抛错（防御性）。
- 不需要新 vitest config，现有 `apps/vscode-ext/vitest.config.ts` 自动 cover `test/**/*.test.ts`。
- webview 交互手工验证；S2/S3 切片结束后做一遍手工走查（添加/编辑/删除/分组折叠/搜索/标签筛选/
  导出/复制）即可，第一期不写 webview e2e。

### 日志与错误

- 用 `diagError`/`diagWarn`/`diagInfo`（diagnostics.ts）分级记录：错误路径（如内部状态
  异常、消息处理未捕获错误）走 `diagError`；可恢复的异常（如某个 secret delete 失败、
  entitlement 拉取失败降级）走 `diagWarn`；正常操作流水（如导入/导出/clearAll 完成）
  走 `diagInfo`。
- 所有日志只打操作元组：`{op:'add', reason:'invalidUri'}` 或短标签字符串加 message 字段
  （如 `diagError('authenticator clearAll failed', String(err))`，对齐
  `sqlCompletionProvider.ts` 现有模式——**只传 `err.message` 或 String(err)，不要把整个
  Error 实例传进去**，避免 V8 某些版本在栈序列化时带上调用参数）。**绝对不**打 secret、
  不打 URI 原文（URI query 里含 secret）、不打 entry 对象完整序列化（entry 本身不含
  secret 但 issuer/account 组合属于用户隐私，不打整对象，只打 id）。
- 用户侧错误消息文案走 i18n key，只说"无效的 otpauth 链接"、"解码失败"、"请先选择或新建分组"、
  "删除分组及 N 个验证码"、"条目已达上限，请升级 Pro"等，不含敏感内容。用户输入错误（如 base32
  非法、URI 解析失败）在表单内联显示，不打 diagError（不是程序错误）。
- 导出时弹 `vscode.window.showWarningMessage` modal 确认，**必须**传 `{ modal: true }`
  并检查返回值是否为「导出」按钮，非 modal 通知容易被忽略，起不到明文风险提示作用。
- 删除分组/删除条目都弹非 modal 确认（或侧滑删除二次确认 UI）。

### 活动栏图标

**不新增容器/图标**：沿用既有 `devbelt` 容器；新增的是容器内第二个视图 `devbelt.tools`
（webview 工具列表，首项 = 验证器）。验证器本体仍以 webview 面板打开。

### 套餐 feature key 迁移

新增迁移文件 `apps/server/src/repository/mysql/migrations/004_authenticator_quota.ts`
（编号接现有 003_plan_ordering 之后；**同步在 `migrations/index.ts` 的 `migrations` 数组
末尾追加**，不要插入中间）。SQL 严格复刻 `002_plan_features_v2.ts` 的幂等写法：

- feature def 插入：用 `INSERT INTO plan_feature_defs ... ON DUPLICATE KEY UPDATE
  feature_key = feature_key`（**不要**在 ON DUPLICATE 子句里更新 label_json/value_type/
  sort_order/unit，避免覆盖运营在控制台调过的值）；def 内容：
  `{ key:'maxAuthenticatorEntries', kind:'personal', labelEn:'Authenticator entries',
  labelZh:'验证器条目', valueType:'number', unit:'count', sortOrder: 95 }`（unit 用英文 token
  `count`，与既有 `maxSavedConnections`/`maxConcurrentConnections` 一致；中文由控制台渲染时本地化）。
- plan 默认值插入：用 `INSERT INTO plan_feature_values ... SELECT ... JOIN ... ON
  DUPLICATE KEY UPDATE value_json = value_json`（同样不覆盖运营已调整的值）；默认值：
  `['free', 'maxAuthenticatorEntries', 10]`、`['pro', 'maxAuthenticatorEntries', 1000]`。
- 同步更新的客户端位置（**4 处，缺一会导致字段不贯通**）：
  1. `packages/db-host/src/sync/entitlementGate.ts`：
     - `CachedEntitlement` 接口加 `maxAuthenticatorEntries?: number;`
     - 新增常量 `DEFAULT_FREE_MAX_AUTH_ENTRIES = 10;`（和 `DEFAULT_FREE_MAX_CONNECTIONS`
       对齐）；
     - 加 helper `maxAuthenticatorEntries(ent)`：取 `entitlement?.maxAuthenticatorEntries`，
       类型为 number 且 ≥0 时返回该值，否则返回 `DEFAULT_FREE_MAX_AUTH_ENTRIES`（fail-closed
       到 free 默认值 10；0 语义上保留为"不限"，当前 free=10/pro=1000 都不会出现 0，未来
       若运营放开某档再调）。helper 风格对齐 `maxSavedConnections`。
  2. `apps/vscode-ext/src/sync/authService.ts` 的 `getMe()` 方法（第 146–156 行
     `setCachedEntitlement({...})` 字面量）：**必须显式加**
     `maxAuthenticatorEntries: sub?.entitlement?.maxAuthenticatorEntries ??
     DEFAULT_FREE_MAX_AUTH_ENTRIES`（import 自 entitlementGate）。
     > ⚠️ 这里是显式枚举字段，不是 spread 透传，不加这一行新字段永远是 `undefined`，
     > 客户端 quota 会恒按 fail-closed 默认值走。
  3. `apps/vscode-ext/src/sync/authService.ts` 的 import 段加
     `DEFAULT_FREE_MAX_AUTH_ENTRIES` 的导入。
  4. 服务端 `billing/service/entitlement.ts` 的 feature key 派生是 EAV 动态的，**不需要改**；
     sync 路由/records 表在 P5 也不动（P5 不同步，服务端看不到 authenticator 条目）。

（服务端侧除迁移外零改动；P5 不同步，sync 路由/records 表都不动。客户端侧除 entitlementGate.ts
加字段+helper 和 authService.ts getMe() 加字段映射外，其它 auth 路径（refresh、logout、
init）都不需要改——setCachedEntitlement 是唯一写入点，读走 getCachedEntitlement。）

## 附：数据与安全的分级（实现约束）

| 数据 | 级别 | 规则 |
|---|---|---|
| TOTP secret | 最高 | 持久化只落 VS Code SecretStorage（存储形态为大写无空格无 padding base32 字符串）；Extension Host 运行期在 `secretCache` 内存缓存用于每秒 TOTP 计算，但 webview **永远**收不到 secret（S2 起所有 webview 渲染都只拿到 code+secondsLeft，secret 不进 postMessage）；不进日志/错误消息/栈/trace（diagError 只传 message，禁止传整个 Error 实例）；未来同步时仅以 DEK 密文上行 |
| 动态口令 | 瞬时敏感 | 扩展主进程计算，只把 code 与 secondsLeft 通过单条 `tick` 消息下发给 webview；不落盘、不缓存到 globalState、不写 clipboard 以外的地方 |
| 条目元数据（issuer/account/algorithm/digits/period/groupId/tags/timestamps） | 受限 | 可入 globalState；未来同步随密文上行 |
| 分组（group name/sortOrder） | 一般 | 可入 globalState；未来同步随密文上行；无秘密 |
| 标签（tag name/color） | 一般 | 可入 globalState；无秘密 |
| 服务端可见 | — | P5 不联网；服务端仅新增一个 feature key 定义 + 默认值迁移；不新增路由、不改表 |

## 附：二维码图片录入（已交付，落地为方案 C）

**状态**：已实现并通过单测（`qrDecode.ts` + provider `addImage`；真实二维码端到端验证通过）。

**目标**：用户把验证器提供的二维码（截图或图片）通过**粘贴 / 拖拽 / 选择图片文件**交给扩展，
解析出单条 `otpauth://totp/...` 并新增条目。桌面端有些站点只渲染二维码、不给文本 secret，
此能力是那种场景下唯一的录入路径。另支持**直接粘贴 otpauth 文本链接**（主进程解析，secret 不进 webview）。

**不做**：摄像头扫码（VS Code webview 无可靠 camera 权限，Remote/Codespaces 更不可能）、
`otpauth-migration` 批量二维码（Google 专属 protobuf，属批量导入）、批量文件导入。

**采用方案 C**：webview 用 `createImageBitmap` + canvas 把图片转成 PNG `dataURL` 回传，主机用
`pngjs` + `jsqr` 解码——secret 文本只在主机出现、解码管线在主机因而**可单测**，运行时依赖 2 个。
（A：主机选文件解码，secret 最安全但 UX 差；B：webview 内解码，secret 文本进 webview——均未采用。）

**复用**：解码得到的文本直接走既有 `parseOtpauthUri()` → `store.addEntry()`；quota 由 `addEntry`
统一返回，不重复判断；`otpauth-migration://` 归为专门的"暂不支持迁移二维码"文案。

**实现要点（已落地）**：
- webview 采集：`<input type=file>`（选择）、`window.paste`（粘贴）、`dragover/drop`（拖拽）；
  canvas 统一转 PNG `dataURL`（`useVsCode.post` 会剥 Vue proxy，typed array 会被破坏，故只回传字符串）。
- 主机 Host 入口 `decodeOtpauthFromPngDataUrl`：PNG dataURL → `pngjs.sync.read` → `jsQR`；
  小图（最长边 <512）原生解不出时做一次 2× 最近邻放大重试。
- 防御：webview 侧 `blob.size` ≤ 15MB、降采样最长边 ≤ 1600；主机侧 base64 ≤ 8MB、像素 ≤ 16M（防图片炸弹）。
- 粘贴焦点守卫：焦点在 `input/textarea/[contenteditable]` 时不劫持普通文本粘贴；`otpauth://` 文本链接
  无论焦点一律走"粘贴链接"。
- CSP 不变：`createImageBitmap` 不触发 `img-src`，未加 `<img>` 预览，无需改 `webview/html.ts`。

**安全**：主进程 → webview 的下行 `secret` 边界不变（snapshot/tick 仍不含 secret）；新增的只是
"用户图片/链接 → 主机"的上行，与 S3 手动填表时 `add` 消息携带用户输入 secret 同理。

**依赖与测试**：`jsqr`、`pngjs`（运行时，随 esbuild 打包）；`qrcode`、`@types/qrcode`、`@types/pngjs`
（dev）。测试：`qrDecode.test.ts`（真实 QR 夹具正解、无码→null、非 PNG/超上限抛错、小图放大）+ provider
`addImage`/`addUri` 用例（成功/未识别/非法/迁移/quota）。
