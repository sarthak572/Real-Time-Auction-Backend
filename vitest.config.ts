import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false, // tests share one real Postgres and Redis
  },
});
