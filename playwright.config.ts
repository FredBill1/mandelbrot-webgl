import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    // Tracing instruments every Worker message and materially distorts the
    // two-second CPU benchmark. Keep it opt-in for diagnostic reruns.
    trace: process.env.PLAYWRIGHT_TRACE === "1" ? "retain-on-failure" : "off"
  },
  webServer: {
    command: "npm run preview -- --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
