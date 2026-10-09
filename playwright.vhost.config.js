const { defineConfig } = require("@playwright/test")

module.exports = defineConfig({
  testDir: "./tests/vhost-manager",
  testMatch: "**/*.spec.js",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4311",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command:
      "VHOST_MANAGER_TEST_MODE=1 VHOST_MANAGER_FIXTURE_ROOT=tests/fixtures/vhost-manager VHOST_MANAGER_PORT=4311 npm run vhost:start",
    url: "http://127.0.0.1:4311/api/session",
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
