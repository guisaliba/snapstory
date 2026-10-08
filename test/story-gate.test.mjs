/**
 * story-gate.test.mjs — tests the Story confirmation interstitial handler and
 * the video-versus-image classification.
 *
 * These tests use local pages with synthetic buttons and images, so they need
 * no Instagram account.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import { prepareStory } from '../src/browser.mjs';
import { INIT_SCRIPT } from '../src/capture.mjs';

function svgDataUrl(width, height) {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'%3E%3C/svg%3E`;
}

async function withPage(run, { init = false } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (init) await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

test('prepareStory clicks the confirmation prompt and classifies video', { timeout: 60000 }, async () => {
  await withPage(async (page) => {
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
    assert.equal(result.kind, 'video');
    assert.equal(result.gateClicks, 1);
    assert.equal(result.videoCount, 1);
  });
});

test('prepareStory clicks a prompt rendered as a plain div without a role', { timeout: 60000 }, async () => {
  await withPage(async (page) => {
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
    assert.equal(result.kind, 'video');
    assert.equal(result.gateClicks, 1);
    assert.equal(result.videoCount, 1);
  });
});

test('prepareStory returns immediately for a video when the element exists', { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await page.setContent('<html><body><video id="v"></video></body></html>');
    const result = await prepareStory(page, { timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'video');
    assert.equal(result.gateClicks, 0);
    assert.equal(result.videoCount, 1);
  });
});

test('prepareStory classifies an image Story after the video grace period', { timeout: 60000 }, async () => {
  const html = `<html><body><img src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px"></body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const result = await prepareStory(page, { timeoutMs: 10000, videoGraceMs: 200 });
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'image');
      assert.equal(result.videoCount, 0);
      assert.ok(result.imageCandidates >= 1);
    },
    { init: true },
  );
});

test('prepareStory remembers the first image before the video grace period', { timeout: 60000 }, async () => {
  const first = svgDataUrl(320, 320);
  const second = svgDataUrl(1600, 2000);
  const html = `<html><body>
    <img id="photo" src="${first}" style="width:300px;height:300px">
    <script>
      setTimeout(() => {
        document.getElementById('photo').src = ${JSON.stringify(second)};
      }, 300);
    </script>
  </body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const result = await prepareStory(page, { timeoutMs: 10000, videoGraceMs: 1200 });
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'image');
      assert.ok(result.imageCandidate, 'expected a remembered image candidate');
      assert.equal(result.imageCandidate.naturalWidth, 320);
    },
    { init: true },
  );
});

test('prepareStory ignores hidden preloaded videos for a photo Story', { timeout: 60000 }, async () => {
  const html = `<html><body>
    <img src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px">
    <video style="display:none"></video>
  </body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const result = await prepareStory(page, { timeoutMs: 10000, videoGraceMs: 200 });
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'image');
      assert.equal(result.videoCount, 0);
      assert.equal(result.videoElements, 1);
    },
    { init: true },
  );
});

test('prepareStory prefers a visible video over an image', { timeout: 60000 }, async () => {
  const html = `<html><body>
    <img src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px">
    <video style="width:400px;height:500px"></video>
  </body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const result = await prepareStory(page, { timeoutMs: 10000, videoGraceMs: 200 });
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'video');
      assert.equal(result.videoCount, 1);
    },
    { init: true },
  );
});

test('prepareStory keeps the video path alive while video buffers are active', { timeout: 60000 }, async () => {
  const html = `<html><body><img src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px"></body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await page.evaluate(() => {
        window.__mseSnapshot = () => ({
          mediaSources: [{ id: 0, buffers: [{ mime: 'video/mp4', chunkCount: 5 }] }],
        });
      });
      const result = await prepareStory(page, { timeoutMs: 1500, videoGraceMs: 200 });
      assert.equal(result.ok, false);
      assert.equal(result.kind, null);
      assert.equal(result.videoCount, 0);
    },
    { init: true },
  );
});

test('prepareStory ignores a preloaded MediaSource with no buffered data', { timeout: 60000 }, async () => {
  const html = `<html><body><img src="${svgDataUrl(800, 1000)}" style="width:400px;height:500px"></body></html>`;
  await withPage(
    async (page) => {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await page.evaluate(() => {
        window.__mseSnapshot = () => ({
          mediaSources: [{ id: 0, buffers: [{ mime: 'video/mp4', chunkCount: 0 }] }],
        });
      });
      const result = await prepareStory(page, { timeoutMs: 10000, videoGraceMs: 200 });
      assert.equal(result.ok, true);
      assert.equal(result.kind, 'image');
    },
    { init: true },
  );
});

test('prepareStory reports failure when no media appears', { timeout: 60000 }, async () => {
  await withPage(async (page) => {
    await page.setContent('<html><body><div>Image story</div><img src="data:,"></body></html>');
    const result = await prepareStory(page, { timeoutMs: 1200 });
    assert.equal(result.ok, false);
    assert.equal(result.kind, null);
    assert.equal(result.videoCount, 0);
    assert.equal(result.imageCount, 1);
  });
});
