import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';
import { ADMIN_ACTOR, APP_URL, MOCK_PORT, VITE_PORT, WORKER_URL } from './e2e/helpers/real-backend/ports.mjs';

// AI Compartment Studio QA against a REAL local stack: wrangler dev (Worker + D1 + R2 + KV, AUTH_MODE=test), Vite with the /api proxy,
// a mock OpenAI and the real AIW processor. Playwright starts and stops every server (workers: 1, one command at a time).
function headlessShell() {
  if (process.env.L1_CHROMIUM_PATH) return process.env.L1_CHROMIUM_PATH;
  if (process.env.L1_HEADLESS_SHELL !== '1' && fs.existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const exe = path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
const executablePath = headlessShell();
const launchOptions = executablePath ? { executablePath } : undefined;
const signedIn = { 'X-Test-Actor': ADMIN_ACTOR };
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, launchOptions };
const phone = { ...devices['Pixel 5'], browserName: 'chromium', deviceScaleFactor: 2, launchOptions };

export default defineConfig({
  testDir: './e2e/studio',
  // *.qa.js (not *.spec.js) so the default `playwright test` (testDir ./e2e) never picks these up without the real stack.
  testMatch: /\.qa\.js$/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-studio' }]],
  globalSetup: './e2e/helpers/real-backend/global-setup.mjs',
  globalTeardown: './e2e/helpers/real-backend/global-teardown.mjs',
  use: { baseURL: APP_URL, trace: 'off', screenshot: 'only-on-failure' },
  outputDir: 'test-results-studio',
  projects: [
    { name: 'desktop', testMatch: /^(?!.*signed-out).*\.qa\.js$/, use: { ...desktop, extraHTTPHeaders: signedIn } },
    { name: 'phone', testMatch: /^(?!.*signed-out).*\.qa\.js$/, use: { ...phone, extraHTTPHeaders: signedIn } },
    { name: 'desktop-signed-out', testMatch: /signed-out\.qa\.js$/, use: desktop },
    { name: 'phone-signed-out', testMatch: /signed-out\.qa\.js$/, use: phone },
  ],
  webServer: [
    { command: 'bash e2e/helpers/real-backend/start-worker.sh', url: `${WORKER_URL}/api/public/planner`, timeout: 180_000, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe', env: { ...process.env } },
    { command: 'node e2e/helpers/real-backend/mock-openai.mjs', url: `http://127.0.0.1:${MOCK_PORT}/health`, timeout: 30_000, reuseExistingServer: false },
    { command: `npx vite --config e2e/helpers/real-backend/vite.studio.config.mjs --host 127.0.0.1 --port ${VITE_PORT} --strictPort`, url: APP_URL, timeout: 60_000, reuseExistingServer: false, env: { ...process.env, L1_API_PROXY: WORKER_URL } },
    { command: 'node e2e/helpers/real-backend/run-processor.mjs', wait: { stdout: /qa-processor started/ }, timeout: 60_000, reuseExistingServer: false },
  ],
});
