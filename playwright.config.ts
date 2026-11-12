import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:3187', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm exec tsx dev/e2e-server.ts',
    url: 'http://127.0.0.1:3187/api/posts',
    timeout: 180_000,
    reuseExistingServer: false,
  },
})
