/**
 * mse-fixture.test.mjs — verifies the injected interceptor independently of
 * Instagram.
 *
 * It generates real fragmented media with FFmpeg, loads a small local page
 * that uses MediaSource/SourceBuffer/appendBuffer, and checks that the
 * interceptor reports both a video and an audio buffer and that the captured
 * bytes match the source bytes exactly.
 *
 * The test needs Chromium and FFmpeg. It never touches Instagram. When no MSE
 * codec is supported and FFmpeg is missing, the test skips instead of failing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { INIT_SCRIPT, CaptureReceiver, waitForPendingDrain } from '../src/capture.mjs';
import { parseTopLevelBoxes } from '../src/media.mjs';

const VIDEO_CANDIDATES = [
  { mime: 'video/mp4; codecs="avc1.42E01E"', family: 'mp4-avc' },
  { mime: 'video/mp4; codecs="vp09.00.10.08"', family: 'mp4-vp9' },
  { mime: 'video/webm; codecs="vp8"', family: 'webm' },
];

const AUDIO_CANDIDATES = [
  { mime: 'audio/mp4; codecs="mp4a.40.2"', family: 'mp4-avc' },
  { mime: 'audio/mp4; codecs="opus"', family: 'mp4-vp9' },
  { mime: 'audio/webm; codecs="opus"', family: 'webm' },
];

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr || result.error}`);
  }
}

function hasFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

/**
 * Split a fragmented MP4 into an init segment and one buffer per `moof`
 * group. Concatenating the result reproduces the input byte for byte.
 */
function splitFragmentedMp4(buffer) {
  const boxes = parseTopLevelBoxes(buffer, { stopAtMoof: false, maxBoxes: 1_000_000 });
  const groups = [];
  let current = [];
  for (const box of boxes) {
    if (box.type === 'moof' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(box);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group) =>
    Buffer.concat(group.map((box) => buffer.subarray(box.offset, box.offset + box.size))),
  );
}

function makeVideoArgs(family, outputPath) {
  const common = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '1.5', '-an'];
  if (family === 'mp4-avc') {
    return [...common, '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p', '-b:v', '400k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', outputPath];
  }
  if (family === 'mp4-vp9') {
    return [...common, '-c:v', 'libvpx-vp9', '-b:v', '300k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', outputPath];
  }
  return [...common, '-c:v', 'libvpx', '-b:v', '300k', '-f', 'webm', outputPath];
}

function makeAudioArgs(family, outputPath) {
  const common = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.5', '-vn'];
  if (family === 'mp4-avc') {
    return [...common, '-c:a', 'aac', '-b:a', '64k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', outputPath];
  }
  if (family === 'mp4-vp9') {
    return [...common, '-c:a', 'libopus', '-b:a', '64k', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', outputPath];
  }
  return [...common, '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', outputPath];
}

test('MSE interceptor captures video and audio buffers byte-for-byte', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg()) {
    t.skip('FFmpeg is not installed');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstory-mse-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstory-fixture-'));
  const receiver = new CaptureReceiver({ workDir, debug: false });
  let browser;
  let context;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await receiver.attach(context);
    await context.addInitScript({ content: INIT_SCRIPT });

    const page = await context.newPage();

    const support = await page.evaluate(
      ({ video, audio }) => ({
        video: video.map((c) => ({ ...c, ok: MediaSource.isTypeSupported(c.mime) })),
        audio: audio.map((c) => ({ ...c, ok: MediaSource.isTypeSupported(c.mime) })),
      }),
      { video: VIDEO_CANDIDATES, audio: AUDIO_CANDIDATES },
    );

    let chosen = null;
    for (const video of support.video) {
      if (!video.ok) continue;
      const audio = support.audio.find((a) => a.ok && a.family === video.family);
      if (audio) {
        chosen = { video, audio };
        break;
      }
    }

    if (!chosen) {
      t.skip('no shared MSE codec is supported by this Chromium build');
      return;
    }

    const videoExt = chosen.video.family === 'webm' ? 'webm' : 'mp4';
    const audioExt = chosen.audio.family === 'webm' ? 'webm' : 'mp4';
    const videoPath = path.join(fixtureDir, `video.${videoExt}`);
    const audioPath = path.join(fixtureDir, `audio.${audioExt}`);
    runFfmpeg(makeVideoArgs(chosen.video.family, videoPath));
    runFfmpeg(makeAudioArgs(chosen.audio.family, audioPath));

    const videoBytes = fs.readFileSync(videoPath);
    const audioBytes = fs.readFileSync(audioPath);

    const videoSegments =
      chosen.video.family === 'webm' ? [videoBytes] : splitFragmentedMp4(videoBytes);
    const audioSegments =
      chosen.audio.family === 'webm' ? [audioBytes] : splitFragmentedMp4(audioBytes);

    // Serve a minimal page over HTTP so the init script runs on a real
    // navigation.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    await page.goto(`http://127.0.0.1:${port}/`);

    const setup = await page.evaluate(
      async ({ videoMime, audioMime, videoSegments, audioSegments }) => {
        const fromBase64 = (value) => {
          const binary = atob(value);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        };

        const mediaSource = new MediaSource();
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        document.body.appendChild(video);
        video.src = URL.createObjectURL(mediaSource);

        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('sourceopen timeout')), 10000);
          mediaSource.addEventListener(
            'sourceopen',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          video.addEventListener('error', () => reject(new Error('video element error')), {
            once: true,
          });
        });

        const videoBuffer = mediaSource.addSourceBuffer(videoMime);
        const audioBuffer = mediaSource.addSourceBuffer(audioMime);

        const append = (sourceBuffer, bytes) =>
          new Promise((resolve, reject) => {
            const onEnd = () => {
              sourceBuffer.removeEventListener('updateend', onEnd);
              resolve();
            };
            sourceBuffer.addEventListener('updateend', onEnd);
            sourceBuffer.addEventListener(
              'error',
              () => reject(new Error('sourcebuffer error')),
              { once: true },
            );
            sourceBuffer.appendBuffer(bytes);
          });

        const videoParts = videoSegments.map(fromBase64);
        const audioParts = audioSegments.map(fromBase64);

        await append(videoBuffer, videoParts[0]);
        await append(audioBuffer, audioParts[0]);
        for (let i = 1; i < Math.max(videoParts.length, audioParts.length); i += 1) {
          if (videoParts[i]) await append(videoBuffer, videoParts[i]);
          if (audioParts[i]) await append(audioBuffer, audioParts[i]);
        }

        return {
          videoChunks: videoParts.length,
          audioChunks: audioParts.length,
        };
      },
      {
        videoMime: chosen.video.mime,
        audioMime: chosen.audio.mime,
        videoSegments: videoSegments.map((segment) => segment.toString('base64')),
        audioSegments: audioSegments.map((segment) => segment.toString('base64')),
      },
    );

    // Wait until the receiver has every chunk.
    const deadline = Date.now() + 30000;
    let snapshot = receiver.snapshot();
    while (
      Date.now() < deadline &&
      !(
        snapshot.buffers.length >= 2 &&
        snapshot.buffers.every((b) => b.chunkCount > 0) &&
        snapshot.buffers.reduce((sum, b) => sum + b.chunkCount, 0) >=
          setup.videoChunks + setup.audioChunks
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      snapshot = receiver.snapshot();
    }

    await waitForPendingDrain(page, { timeoutMs: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await receiver.finalize();
    await new Promise((resolve) => server.close(resolve));

    snapshot = receiver.snapshot();
    const videoEntry = snapshot.buffers.find((b) => b.mime.startsWith('video/'));
    const audioEntry = snapshot.buffers.find((b) => b.mime.startsWith('audio/'));
    assert.ok(videoEntry, 'expected a captured video buffer');
    assert.ok(audioEntry, 'expected a captured audio buffer');
    assert.equal(videoEntry.chunkCount, setup.videoChunks);
    assert.equal(audioEntry.chunkCount, setup.audioChunks);

    const capturedVideo = fs.readFileSync(videoEntry.path);
    const capturedAudio = fs.readFileSync(audioEntry.path);
    assert.equal(capturedVideo.length, videoBytes.length);
    assert.ok(capturedVideo.equals(videoBytes), 'captured video bytes must match the source');
    assert.ok(capturedAudio.equals(audioBytes), 'captured audio bytes must match the source');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
