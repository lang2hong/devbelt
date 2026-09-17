/**
 * Fastify 插件类型增强。
 * 让 TS 识别 app.mysql（@fastify/mysql）。
 *
 * `export {}` 使本文件成为模块，`declare module 'fastify'` 因此是**模块增强**
 * 而非模块声明 —— 否则（无顶层 import/export 的全局脚本）会覆盖 fastify 自带
 * 类型，导致 FastifyInstance/FastifyReply 等全部丢失。
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** @fastify/mysql 注入的 MySQL 连接池（promise 模式） */
    mysql: import('../repository/mysql/db.js').MysqlDb;
  }
}

export {};
