/**
 * story-gate.test.mjs — tests the Story confirmation interstitial handler.
 *
 * Instagram sometimes blocks media load behind a "View story" confirmation.
 * These tests use a local page with a synthetic button, so they need no
 * Instagram account.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import { prepareStory } from '../src/browser.mjs';

test('prepareStory clicks the confirmation prompt and waits for the video', { timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <button id="gate">View story</button>
        <div id="stage"></div>
        <script>
          document.getElementById('gate').addEventListener('click', () => {
            document.getElementById('gate').remove();
            const video = document.createElement('video');
            video.id = 'story-video';
            document.getElementById('stage').appendChild(video);
          });
        </script>
      </body></html>
    `);

    const result = await prepareStory(page, { timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.gateClicks, 1);
    assert.equal(result.videoCount, 1);
  } finally {
    await browser.close();
  }
});

test('prepareStory clicks a prompt rendered as a plain div without a role', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <div id="gate" style="width:120px;height:40px">View story</div>
        <div id="stage"></div>
        <script>
          document.getElementById('gate').addEventListener('click', () => {
            document.getElementById('gate').remove();
            document.getElementById('stage').appendChild(document.createElement('video'));
          });
        </script>
      </body></html>
    `);

    const result = await prepareStory(page, { timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.gateClicks, 1);
    assert.equal(result.videoCount, 1);
  } finally {
    await browser.close();
  }
});

test('prepareStory returns immediately when the video already exists', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><video id="v"></video></body></html>');
    const result = await prepareStory(page, { timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.gateClicks, 0);
    assert.equal(result.videoCount, 1);
  } finally {
    await browser.close();
  }
});

test('prepareStory reports failure when no video appears', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body><div>Image story</div><img src="data:,"></body></html>');
    const result = await prepareStory(page, { timeoutMs: 1200 });
    assert.equal(result.ok, false);
    assert.equal(result.videoCount, 0);
    assert.equal(result.imageCount, 1);
  } finally {
    await browser.close();
  }
});
