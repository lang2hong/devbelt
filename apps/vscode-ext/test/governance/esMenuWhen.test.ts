import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const menus: Array<{ command: string; when?: string }> = pkg?.contributes?.menus?.['view/item/context'] ?? [];
const commands: Array<{ command: string }> = pkg?.contributes?.commands ?? [];

/**
 * P8 S2：Elasticsearch 菜单 / 表单机械门禁（对齐 P7 redisMenuWhen 的教训：
 * host 测试全绿但入口不可达的情况必须用机械断言守住）。
 */
describe('Elasticsearch 菜单与表单（P8 S2）', () => {
  it('ES 专属命令已声明且有对应菜单项（连接/索引类别/索引节点，含只读 .ro 变体）', () => {
    const declared = new Set(commands.map((c) => c.command));
    const expectMenu = (cmd: string, base: string): void => {
      expect(declared.has(cmd), cmd).toBe(true);
      expect(menus.some((m) => m.command === cmd && m.when?.includes(base)), `${cmd} @ ${base}`).toBe(true);
    };
    expectMenu('devbelt.es.cluster', 'connectionOpen.ELASTICSEARCH');
    expectMenu('devbelt.es.rest', 'connectionOpen.ELASTICSEARCH');
    expectMenu('devbelt.es.indices', 'connectionOpen.ELASTICSEARCH');
    expectMenu('devbelt.es.indices', 'esIndexCategory.ELASTICSEARCH');
    expectMenu('devbelt.es.index', 'esIndex.ELASTICSEARCH');
    expectMenu('devbelt.es.documents', 'esIndex.ELASTICSEARCH');
    expectMenu('devbelt.es.dsl', 'esIndex.ELASTICSEARCH');
    expectMenu('devbelt.es.nodes', 'connectionOpen.ELASTICSEARCH');
    expectMenu('devbelt.refreshNode', 'esIndexCategory.ELASTICSEARCH');
    expectMenu('devbelt.copyNodeName', 'esIndex.ELASTICSEARCH');
  });

  it('连接表单 dbType 下拉含 Elasticsearch 选项（否则 ES 表单段不可达）', () => {
    const vue = readFileSync(join(process.cwd(), 'webview/src/views/ConnectionFormView.vue'), 'utf8');
    expect(vue).toMatch(/<option value="ELASTICSEARCH"/);
  });

  it('表单 ES 字段被消费：协议 / 认证方式 / Basic 用户名 / API Key', () => {
    const vue = readFileSync(join(process.cwd(), 'webview/src/views/ConnectionFormView.vue'), 'utf8');
    for (const binding of ['v-model="form.esProtocol"', 'v-model="form.esAuth"', 'v-model="form.esUser"', 'v-model="form.esApiKey"']) {
      expect(vue, binding).toContain(binding);
    }
  });

  it('ES 默认 Basic Auth + elastic；认证块位于数据库行之前（与其它库用户名/密码同位置）', () => {
    const vue = readFileSync(join(process.cwd(), 'webview/src/views/ConnectionFormView.vue'), 'utf8');
    expect(vue).toMatch(/esAuth: 'basic'/);
    expect(vue).toMatch(/esUser: 'elastic'/);
    const authIdx = vue.indexOf('v-model="form.esAuth"');
    const dbIdx = vue.indexOf("t('wv.form.database')");
    expect(authIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(dbIdx);
  });

  it('host 侧解码 ES 字段：decodeEsAuth 白名单 + esProtocol 归一', () => {
    const host = readFileSync(join(process.cwd(), 'src/connection/connectionForm.ts'), 'utf8');
    expect(host).toContain('function decodeEsAuth');
    expect(host).toMatch(/esProtocol.*'https'/);
  });

  it('树「集群」节点点击打开集群总览（devbelt.es.cluster 可达）', () => {
    const tree = readFileSync(join(process.cwd(), 'src/tree/dbTreeDataProvider.ts'), 'utf8');
    expect(tree).toContain("'devbelt.es.cluster'");
  });

  it('ES 连接节点不匹配 Redis / SQL 专属命令菜单', () => {
    const esValues = [
      'connectionOpen.ELASTICSEARCH',
      'connectionOpen.ELASTICSEARCH.ro',
      'connectionClosed.ELASTICSEARCH',
      'connectionClosed.ELASTICSEARCH.ro',
      'esClusterInfo.ELASTICSEARCH',
      'esIndexCategory.ELASTICSEARCH',
      'esIndex.ELASTICSEARCH',
    ];
    const exclusive: string[] = [
      'devbelt.redis.console', 'devbelt.redis.serverStatus', 'devbelt.redis.monitor',
      'devbelt.redis.slowlog', 'devbelt.redis.commandLog', 'devbelt.redis.newKey',
      'devbelt.redis.keyBrowser', 'devbelt.redis.deleteByPattern', 'devbelt.redis.loadAllFolderKeys', 'devbelt.redis.loadMoreFolderKeys',
      'devbelt.newQueryFromConn', 'devbelt.createDatabase', 'devbelt.openTerminal',
      'devbelt.importData', 'devbelt.exportData', 'devbelt.dataSync',
    ];
    const matcher = (when: string): ((v: string) => boolean) => {
      const parts = when.split('||').map((part) => {
        const eq = part.match(/viewItem\s*==\s*([\w.]+)/);
        if (eq) return (v: string) => v === eq[1];
        const re = part.match(/viewItem\s*=~\s*\/(.+?)\/(?=\s|$)/);
        return re ? (v: string) => new RegExp(re[1]).test(v) : undefined;
      }).filter((f): f is (v: string) => boolean => !!f);
      return (v) => parts.some((m) => m(v));
    };
    const hits: string[] = [];
    for (const entry of menus) {
      if (!exclusive.includes(entry.command) || !entry.when) continue;
      const match = matcher(entry.when);
      if (esValues.some(match)) hits.push(`${entry.command}: ${entry.when}`);
    }
    expect(hits, `ES 连接上出现了 Redis/SQL 专属命令`).toEqual([]);
  });

  it('ES 面板分支可达：viewType + App.vue mode 分支 + WebviewMode 联合', () => {
    const view = readFileSync(join(process.cwd(), 'src/result/elasticsearchView.ts'), 'utf8');
    expect(view).toContain("'devbelt.elasticsearch'");
    const app = readFileSync(join(process.cwd(), 'webview/src/App.vue'), 'utf8');
    expect(app).toContain("mode === 'elasticsearch'");
    const protocol = readFileSync(join(process.cwd(), 'src/result/protocol.ts'), 'utf8');
    expect(protocol).toMatch(/'elasticsearch'/);
  });
});