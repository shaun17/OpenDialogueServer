import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // security/ 和 routes/ 的纯逻辑测试用 node 环境运行，速度快
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
  },
});
