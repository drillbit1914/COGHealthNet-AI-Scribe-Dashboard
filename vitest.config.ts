import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    // AC 14: prove rendering is AST regardless of the machine's timezone.
    env: { TZ: 'Asia/Tokyo' },
    setupFiles: ['tests/unit/setup-env.ts'],
    globalSetup: ['tests/unit/global-setup.ts'],
  },
});
