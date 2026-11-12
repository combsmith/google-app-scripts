// @ts-check
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  // Only pick up .spec.js files (Jest picks up .test.js — no overlap).
  testMatch: ['gas-installer/tests/*.spec.js', 'deploy/tests/*.spec.js'],
  use: {
    headless: true,
    browserName: 'chromium',
  },
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  // Keep test-result artifacts out of the root directory (the CI-only HTML
  // reporter intentionally writes ./playwright-report at the repo root).
  outputDir: 'test-results/playwright',
  // Each test should complete well within this limit since all external
  // calls are mocked/intercepted.
  timeout: 15000,
  expect: {
    timeout: 8000,
  },
  // Playwright tests run in isolation — no shared browser between tests.
  fullyParallel: false,
  workers: 1,
})
