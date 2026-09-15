/**
 * `@db-client/core/testing` 公共入口：仅供测试使用的同步协议向量。
 *
 * 独立子路径而非 `dist/sync/*` 深链：加 `exports` 映射后深链会被封死，
 * 且测试向量属于「半公开」面，用显式子路径表达更清晰。
 */
export * from '../sync/jcsVectors.js';
export * from '../sync/signVector.js';