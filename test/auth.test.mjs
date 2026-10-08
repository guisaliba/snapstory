/**
 * auth.test.mjs — tests for the authentication check and its diagnostics,
 * using fake contexts. No browser and no Instagram.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureAuthenticated } from '../src/browser.mjs';

function fakePage() {
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
  };
}

test('ensureAuthenticated fails fast in headless mode and names the profile', async () => {
  const lines = [];
  const context = {
    cookies: async () => [{ name: 'csrftoken', value: 'x' }, { name: 'ds_user_id', value: 'y' }],
  };

  await assert.rejects(
    () =>
      ensureAuthenticated(context, fakePage(), {
        timeoutMs: 1000,
        log: (line) => lines.push(line),
        debug: true,
        headless: true,
        profileDir: '/tmp/wrong-profile',
      }),
    (error) =>
      error.code === 'auth-required' && error.message.includes('/tmp/wrong-profile'),
  );

  assert.ok(
    lines.some((line) => line.includes('[auth] instagram.com cookie names: csrftoken, ds_user_id')),
    `expected a cookie-name diagnostic line, got: ${lines.join(' | ')}`,
  );
});

test('ensureAuthenticated accepts an existing session', async () => {
  const lines = [];
  const context = {
    cookies: async () => [{ name: 'sessionid', value: 'secret-value' }],
  };

  await ensureAuthenticated(context, fakePage(), {
    timeoutMs: 1000,
    log: (line) => lines.push(line),
    debug: true,
    headless: true,
    profileDir: '/tmp/profile',
  });

  assert.ok(lines.some((line) => line.includes('Authenticated as existing Instagram session.')));
  assert.ok(lines.some((line) => line.includes('cookie names: sessionid')));
  assert.ok(
    lines.every((line) => !line.includes('secret-value')),
    'cookie values must never be logged',
  );
});
