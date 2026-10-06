/**
 * remux.test.mjs — real FFmpeg integration without Instagram.
 *
 * Generates fragmented MP4 video and audio with FFmpeg, remuxes them through
 * the same `remux()` the CLI uses (stream copy only), then validates the
 * result with FFprobe. This proves the reconstruction-to-container path.
 *
 * Skips when FFmpeg or FFprobe is missing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRemuxArgs, hasFfprobe, probe, remux, validateProbe } from '../src/ffmpeg.mjs';

function hasFfmpeg() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr || result.error}`);
  }
}

function makeVideo(target) {
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '2', '-an',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-b:v', '400k',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', target,
  ]);
}

function makeAudio(target) {
  runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-vn',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', target,
  ]);
}

test('remux joins video and audio with stream copy', { timeout: 120000 }, async (t) => {
  if (!hasFfmpeg() || !hasFfprobe()) {
    t.skip('FFmpeg or FFprobe is not installed');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstory-remux-'));
  try {
    const videoPath = path.join(dir, 'video.mp4');
    const audioPath = path.join(dir, 'audio.mp4');
    const outputPath = path.join(dir, 'story.mp4');
    makeVideo(videoPath);
    makeAudio(audioPath);

    const args = buildRemuxArgs({ videoPath, audioPath, outputPath });
    assert.ok(args.includes('-c') && args.includes('copy'));

    await remux({ videoPath, audioPath, outputPath });
    const stat = fs.statSync(outputPath);
    assert.ok(stat.size > 0, 'output must not be empty');

    const summary = validateProbe(await probe(outputPath), { expectAudio: true });
    assert.equal(summary.videoStreams, 1);
    assert.equal(summary.audioStreams, 1);
    assert.ok(summary.duration > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remux handles a video-only Story', { timeout: 120000 }, async (t) => {
  if (!hasFfmpeg() || !hasFfprobe()) {
    t.skip('FFmpeg or FFprobe is not installed');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapstory-remux-'));
  try {
    const videoPath = path.join(dir, 'video.mp4');
    const outputPath = path.join(dir, 'story.mp4');
    makeVideo(videoPath);

    await remux({ videoPath, outputPath });
    const summary = validateProbe(await probe(outputPath), { expectAudio: false });
    assert.equal(summary.videoStreams, 1);
    assert.equal(summary.audioStreams, 0);
    assert.ok(summary.duration > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
