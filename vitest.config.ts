import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // security/ 和 routes/ 的纯逻辑测试用 node 环境运行，速度快
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    // 集成测试各自启动 wrangler worker 共享同一本地 D1 SQLite 文件，
    // 并发写会触发锁冲突，串行执行可避免此问题
    fileParallelism: false,
  },
});
