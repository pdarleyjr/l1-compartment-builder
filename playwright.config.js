import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

// While shared/planner.js is still the unimplemented interface stub, the dev server aliases it to a test shim.
const plannerIsStub = /NOT_IMPLEMENTED/.test(fs.readFileSync(new URL('./shared/planner.js', import.meta.url), 'utf8'));

// Sandboxed workers cannot always start the full Chromium (crashpad) or may only have another revision cached. Use the
// cached chromium_headless_shell binary when L1_HEADLESS_SHELL=1, when L1_CHROMIUM_PATH is set, or when the default
// Chromium of this Playwright version is not installed.
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

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions } },
    { name: 'tablet-chromium', use: { ...devices['iPad (gen 7)'], browserName: 'chromium', launchOptions } },
    { name: 'phone-chromium', use: { ...devices['Pixel 5'], browserName: 'chromium', launchOptions } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: { ...process.env, L1_PLANNER_SHIM: plannerIsStub ? '1' : '0' },
  },
});
