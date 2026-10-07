/**
 * image-fixture.test.mjs — tests the Story image machinery in real Chromium
 * against local pages. No Instagram account and no FFmpeg.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { chromium } from 'playwright';

import { INIT_SCRIPT } from '../src/capture.mjs';

function svgDataUrl(width, height) {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'%3E%3C/svg%3E`;
}

async function withServer(html, run) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withBrowser(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

test('image observer registers images with natural size and visibility', { timeout: 60000 }, async () => {
  const html = `<!doctype html><html><body>
    <img id="small" src="${svgDataUrl(320, 240)}" style="width:160px;height:120px">
    <img id="large" src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px">
    <img id="hidden" src="${svgDataUrl(900, 900)}" style="display:none">
  </body></html>`;

  await withServer(html, async (url) => {
    await withBrowser(async (page) => {
      await page.goto(url);
      await page.waitForFunction(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return images.length === 3 && images.every((image) => image.complete);
      });

      const snapshot = await page.evaluate(() => window.__snapstorySnapshotImages());
      assert.equal(snapshot.length, 3);

      const large = snapshot.find((candidate) => candidate.naturalWidth === 800);
      assert.ok(large, 'expected the 800x1000 image');
      assert.equal(large.naturalHeight, 1000);
      assert.equal(large.renderedWidth, 400);
      assert.equal(large.renderedHeight, 500);
      assert.equal(large.visible, true);
      assert.ok(large.id >= 0);
      assert.ok(large.insertedAt > 0);

      const hidden = snapshot.find((candidate) => candidate.naturalWidth === 900);
      assert.ok(hidden, 'expected the hidden image to be registered');
      assert.equal(hidden.visible, false);

      const ids = new Set(snapshot.map((candidate) => candidate.id));
      assert.equal(ids.size, 3);
    });
  });
});

test('image observer updates recency when the source changes', { timeout: 60000 }, async () => {
  const html = `<!doctype html><html><body>
    <img id="photo" src="${svgDataUrl(320, 320)}" style="width:300px;height:300px">
  </body></html>`;

  await withServer(html, async (url) => {
    await withBrowser(async (page) => {
      await page.goto(url);
      await page.waitForFunction(() => {
        const image = document.querySelector('img');
        return image && image.complete && image.naturalWidth === 320;
      });

      const before = (await page.evaluate(() => window.__snapstorySnapshotImages()))[0];

      await page.evaluate((next) => {
        document.querySelector('img').src = next;
      }, svgDataUrl(1600, 2000));

      await page.waitForFunction(() => {
        const image = document.querySelector('img');
        return image && image.complete && image.naturalWidth === 1600;
      });

      const after = (await page.evaluate(() => window.__snapstorySnapshotImages()))[0];
      assert.equal(after.naturalWidth, 1600);
      assert.equal(after.naturalHeight, 2000);
      assert.notEqual(after.url, before.url);
      assert.ok(after.lastSrcChangeAt >= before.lastSrcChangeAt);
    });
  });
});
