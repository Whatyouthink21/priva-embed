import { spawn } from 'node:child_process';
import { chromium as playwright } from '@playwright/test';
import chromium from '@sparticuz/chromium';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
mkdirSync('.cache', { recursive: true });
// The server is started in setup-required mode so the checks are deterministic
// and never depend on outbound provider access.
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: '3000', TMDB_API_KEY: '', CONSUMET_MODE: 'library' },
  stdio: ['ignore', 'pipe', 'inherit']
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server did not log a startup line in time')), 20000);
  server.stdout.on('data', chunk => { if (String(chunk).includes('listening on port')) { clearTimeout(timer); resolve(); } });
  server.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited early (${code})`)); });
});
const localLibs = path.resolve('.cache/chromium-libs/lib');
const browser = await playwright.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || await chromium.executablePath(),
  args: chromium.args.filter(arg => !arg.includes('disable-web-security') && !arg.includes('allow-running-insecure-content')),
  env: { ...process.env, ...(existsSync(localLibs) ? { LD_LIBRARY_PATH: localLibs + ':' + (process.env.LD_LIBRARY_PATH || '') } : {}) },
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3000/test');
  await page.getByText('Resolver setup required', { exact: false }).waitFor();
  const player = page.frameLocator('#preview');
  await player.getByRole('button', { name: 'Play demo' }).waitFor();
  await player.getByRole('button', { name: 'Play demo' }).click();
  await page.waitForTimeout(1200);
  const playback = await player.locator('video').evaluate(v => ({ time: v.currentTime, paused: v.paused, ready: v.readyState }));
  assert.ok(playback.time > 0, JSON.stringify(playback)); assert.equal(playback.paused, false);
  await page.screenshot({ path: '.cache/playground-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'TV episode', exact: true }).click();
  await page.locator('#tmdb').fill('1399');
  await page.locator('#season').fill('2');
  await page.locator('#episode').fill('3');
  await page.locator('#autoplay').check();
  await page.getByRole('button', { name: 'Load embed' }).click();
  await player.getByText('Set TMDB_API_KEY', { exact: false }).waitFor();
  assert.ok((await page.locator('#embed-code').textContent()).includes('/embed/tv/1399/2/3?autoplay=1'));
  await page.getByRole('button', { name: 'Send request' }).click();
  await page.locator('#api-response').filter({ hasText: 'SETUP_REQUIRED' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.cache/playground-mobile.png', fullPage: true });
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(horizontalOverflow, false);
  await page.goto('http://127.0.0.1:3000/embed/movie/nope');
  await page.getByText('Invalid embed URL.').waitFor();
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: actual demo playback, TV iframe generation, setup errors, API request, mobile layout, invalid URLs.');
} finally { await browser.close(); server.kill('SIGTERM'); }
