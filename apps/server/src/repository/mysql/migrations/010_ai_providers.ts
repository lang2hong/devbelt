import type { Migration } from '../migrate.js';

/**
 * AI 模型厂商目录（自带 Key 模式的预设；增量，迁移账本只跑一次）。
 *
 * 新表 `ai_providers`：管理后台维护的 OpenAI 兼容厂商（code 唯一；name_json/base_url/
 * models_json/status/sort_order）。客户端只读取启用项并让用户填 API Key；Key 永不经服务端。
 * 预置 8 家（OpenAI/阿里百炼/DeepSeek/智谱/小米 MiMo/Moonshot/硅基流动/MiniMax；
 * `ON DUPLICATE KEY UPDATE code = code` 幂等，不覆盖运营已改动的行）。
 * 预置的地址与模型名取自各家官方文档的常用值，运营应在后台核对（模型迭代快）。
 *
 * 回滚（见 docs/迁移回滚.md）：
 * ```sql
 * DROP TABLE ai_providers;
 * ```
 */
type Seed = [code: string, name: { en: string; zh: string }, baseUrl: string, models: Array<{ id: string; default?: boolean }>, sort: number];

const SEEDS: ReadonlyArray<Seed> = [
  ['openai', { en: 'OpenAI', zh: 'OpenAI' }, 'https://api.openai.com/v1', [{ id: 'gpt-4o-mini', default: true }, { id: 'gpt-4o' }, { id: 'gpt-4.1-mini' }], 10],
  ['dashscope', { en: 'Alibaba Bailian', zh: '阿里百炼' }, 'https://dashscope.aliyuncs.com/compatible-mode/v1', [{ id: 'qwen-plus', default: true }, { id: 'qwen-max' }, { id: 'qwen-turbo' }], 20],
  ['deepseek', { en: 'DeepSeek', zh: 'DeepSeek' }, 'https://api.deepseek.com/v1', [{ id: 'deepseek-chat', default: true }, { id: 'deepseek-reasoner' }], 30],
  ['zhipu', { en: 'Zhipu AI', zh: '智谱' }, 'https://open.bigmodel.cn/api/paas/v4', [{ id: 'glm-4-plus', default: true }, { id: 'glm-4-air' }, { id: 'glm-4-flash' }], 40],
  ['xiaomi', { en: 'Xiaomi MiMo', zh: '小米 MiMo' }, 'https://api.xiaomimimo.com/v1', [{ id: 'mimo-v2.6-flash', default: true }, { id: 'mimo-v2.6-pro' }], 50],
  ['moonshot', { en: 'Moonshot (Kimi)', zh: 'Moonshot（Kimi）' }, 'https://api.moonshot.cn/v1', [{ id: 'moonshot-v1-8k', default: true }, { id: 'moonshot-v1-32k' }], 60],
  ['siliconflow', { en: 'SiliconFlow', zh: '硅基流动' }, 'https://api.siliconflow.cn/v1', [{ id: 'Qwen/Qwen2.5-72B-Instruct', default: true }, { id: 'deepseek-ai/DeepSeek-V3' }, { id: 'Qwen/Qwen2.5-Coder-32B-Instruct' }], 70],
  ['minimax', { en: 'MiniMax', zh: 'MiniMax' }, 'https://api.minimaxi.com/v1', [{ id: 'MiniMax-M3', default: true }, { id: 'MiniMax-M2' }], 80],
];

export const aiProvidersMigration: Migration = {
  version: '010_ai_providers',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_providers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(32) NOT NULL,
        name_json JSON NOT NULL,
        base_url VARCHAR(255) NOT NULL,
        models_json JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        sort_order INT NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_ai_providers_code (code),
        KEY idx_ai_providers_status (status, sort_order),
        CONSTRAINT chk_ai_providers_status CHECK (status IN ('active', 'disabled'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    for (const [code, name, baseUrl, models, sort] of SEEDS) {
      await db.query(
        `INSERT INTO ai_providers (code, name_json, base_url, models_json, status, sort_order)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON DUPLICATE KEY UPDATE code = code`,
        [code, JSON.stringify(name), baseUrl, JSON.stringify(models), sort],
      );
    }
  },
};
