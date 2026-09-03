// 打包红线门禁用 fixture：模拟未来 compose root 导入主线程门面，
// 用同一 esbuild 配置证明 `deriveKekSmpInWorker` 不会把 hash-wasm / Argon2id 执行体
// 拖进主线程 bundle。非生产入口，仅作为 `mainThreadFixture.js` 构建产物供门禁断言。
import { deriveKekSmpInWorker } from './smpKdf';

export { deriveKekSmpInWorker };