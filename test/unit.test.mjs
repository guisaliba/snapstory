/**
 * unit.test.mjs — tests that need no Instagram account, no FFmpeg, and no
 * browser. They cover argument parsing, URL validation, MIME classification,
 * buffer selection, ordered assembly, fragmented-MP4 inspection, output
 * naming, and FFmpeg argument construction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../src/errors.mjs';
import { parseCliArgs, validateStoryUrl } from '../src/cli.mjs';
import {
  classifyMime,
  deriveOutputPath,
  formatBytes,
  inspectInitSegment,
  isAudioMp4,
  isVideoMp4,
  nextAvailablePath,
  parseTopLevelBoxes,
  sanitizeComponent,
  selectBuffers,
} from '../src/media.mjs';
import { OrderedWriter } from '../src/capture.mjs';
import { buildRemuxArgs, validateProbe } from '../src/ffmpeg.mjs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

test('parseCliArgs parses the URL and every option', () => {
  const opts = parseCliArgs([
    'https://www.instagram.com/stories/example/123/',
    '-o',
    './out.mp4',
    '--profile',
    '/tmp/p',
    '--keep-temp',
    '--headed',
    '--timeout',
    '30',
    '--debug',
    '--force',
  ]);
  assert.equal(opts.url, 'https://www.instagram.com/stories/example/123/');
  assert.equal(opts.output, './out.mp4');
  assert.equal(opts.profile, '/tmp/p');
  assert.equal(opts.keepTemp, true);
  assert.equal(opts.headed, true);
  assert.equal(opts.headless, false);
  assert.equal(opts.timeoutMs, 30000);
  assert.equal(opts.debug, true);
  assert.equal(opts.force, true);
});

test('parseCliArgs defaults the timeout to 120 seconds', () => {
  const opts = parseCliArgs(['https://www.instagram.com/stories/example/123/']);
  assert.equal(opts.timeoutMs, 120000);
  assert.equal(opts.output, null);
  assert.equal(opts.force, false);
});

test('parseCliArgs rejects a missing URL', () => {
  assert.throws(() => parseCliArgs([]), (error) => error.code === 'bad-usage');
});

test('parseCliArgs parses --headless', () => {
  const opts = parseCliArgs(['https://www.instagram.com/stories/example/123/', '--headless']);
  assert.equal(opts.headless, true);
});

test('parseCliArgs defaults to headless', () => {
  const opts = parseCliArgs(['https://www.instagram.com/stories/example/123/']);
  assert.equal(opts.headless, true);
  assert.equal(opts.headed, false);
});

test('parseCliArgs rejects --headed together with --headless', () => {
  assert.throws(
    () =>
      parseCliArgs([
        'https://www.instagram.com/stories/example/123/',
        '--headed',
        '--headless',
      ]),
    (error) => error.code === 'bad-usage',
  );
});

test('parseCliArgs rejects a non-numeric timeout', () => {
  assert.throws(
    () => parseCliArgs(['https://www.instagram.com/stories/example/123/', '--timeout', 'soon']),
    (error) => error.code === 'bad-usage',
  );
});

test('parseCliArgs parses --device-scale-factor', () => {
  const opts = parseCliArgs([
    'https://www.instagram.com/stories/example/123/',
    '--device-scale-factor',
    '3',
  ]);
  assert.equal(opts.deviceScaleFactor, 3);
});

test('parseCliArgs defaults deviceScaleFactor to 2', () => {
  const opts = parseCliArgs(['https://www.instagram.com/stories/example/123/']);
  assert.equal(opts.deviceScaleFactor, 2);
});

test('parseCliArgs rejects an invalid device scale factor', () => {
  assert.throws(
    () => parseCliArgs(['https://www.instagram.com/stories/example/123/', '--device-scale-factor', '0']),
    (error) => error.code === 'bad-usage',
  );
  assert.throws(
    () => parseCliArgs(['https://www.instagram.com/stories/example/123/', '--device-scale-factor', 'x']),
    (error) => error.code === 'bad-usage',
  );
});

test('parseCliArgs rejects an unknown option', () => {
  assert.throws(
    () => parseCliArgs(['https://www.instagram.com/stories/example/123/', '--nope']),
    (error) => error.code === 'bad-usage',
  );
});

test('parseCliArgs recognises help', () => {
  assert.equal(parseCliArgs(['-h']).help, true);
  assert.equal(parseCliArgs(['--help']).help, true);
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

test('validateStoryUrl accepts a normal Story URL and extracts its parts', () => {
  const result = validateStoryUrl('https://www.instagram.com/stories/example/123456789/');
  assert.deepEqual(result, {
    url: 'https://www.instagram.com/stories/example/123456789/',
    username: 'example',
    storyId: '123456789',
  });
});

test('validateStoryUrl accepts an id-less user Story URL', () => {
  const result = validateStoryUrl('https://www.instagram.com/stories/spilarii/');
  assert.deepEqual(result, {
    url: 'https://www.instagram.com/stories/spilarii/',
    username: 'spilarii',
    storyId: null,
  });
});

test('validateStoryUrl accepts an id-less user Story URL without a trailing slash', () => {
  const result = validateStoryUrl('https://www.instagram.com/stories/spilarii');
  assert.equal(result.url, 'https://www.instagram.com/stories/spilarii/');
  assert.equal(result.storyId, null);
});

test('validateStoryUrl accepts harmless query parameters', () => {
  const result = validateStoryUrl(
    'https://www.instagram.com/stories/example/123456789/?hl=en',
  );
  assert.equal(result.storyId, '123456789');
});

test('validateStoryUrl rejects a non-Instagram host', () => {
  assert.throws(
    () => validateStoryUrl('https://example.com/stories/example/123/'),
    (error) => error.code === 'invalid-url',
  );
});

test('validateStoryUrl rejects a profile URL', () => {
  assert.throws(
    () => validateStoryUrl('https://www.instagram.com/example/'),
    (error) => error.code === 'invalid-url',
  );
});

test('validateStoryUrl rejects a non-numeric story id', () => {
  assert.throws(
    () => validateStoryUrl('https://www.instagram.com/stories/example/abc/'),
    (error) => error.code === 'invalid-url',
  );
});

// ---------------------------------------------------------------------------
// MIME classification
// ---------------------------------------------------------------------------

test('classifyMime routes video, audio, and other', () => {
  assert.equal(classifyMime('video/mp4; codecs="avc1.640028"'), 'video');
  assert.equal(classifyMime('audio/mp4; codecs="mp4a.40.2"'), 'audio');
  assert.equal(classifyMime('text/html'), 'other');
  assert.equal(classifyMime(undefined), 'other');
});

test('isVideoMp4 and isAudioMp4 ignore codec parameters', () => {
  assert.equal(isVideoMp4('video/mp4; codecs="avc1.640028"'), true);
  assert.equal(isVideoMp4('video/webm; codecs="vp8"'), false);
  assert.equal(isAudioMp4('audio/mp4; codecs="mp4a.40.2"'), true);
  assert.equal(isAudioMp4('video/mp4'), false);
});

// ---------------------------------------------------------------------------
// SourceBuffer selection
// ---------------------------------------------------------------------------

function buffer(id, mime, chunkCount, byteCount, order = id) {
  return { id, mime, chunkCount, byteCount, order, path: `/tmp/b${id}.mp4` };
}

function snapshot(mediaSources, activeMediaSourceId) {
  return { activeMediaSourceId, mediaSources, videos: [], pageToken: 'p' };
}

test('selectBuffers finds video and audio by MIME, not by order', () => {
  const selected = selectBuffers(
    snapshot(
      [
        {
          id: 7,
          objectUrl: 'blob:1',
          buffers: [
            buffer(0, 'audio/mp4; codecs="mp4a.40.2"', 9, 312000, 0),
            buffer(1, 'video/mp4; codecs="avc1.640028"', 14, 3980000, 1),
          ],
        },
      ],
      7,
    ),
  );
  assert.equal(selected.video.id, 1);
  assert.equal(selected.audio.id, 0);
});

test('selectBuffers returns null audio for a video-only Story', () => {
  const selected = selectBuffers(
    snapshot([{ id: 1, objectUrl: 'blob:1', buffers: [buffer(0, 'video/mp4', 3, 1000)] }], 1),
  );
  assert.equal(selected.audio, null);
  assert.equal(selected.video.id, 0);
});

test('selectBuffers ignores preloaded MediaSources and uses the active one', () => {
  const selected = selectBuffers(
    snapshot(
      [
        { id: 1, objectUrl: 'blob:old', buffers: [buffer(0, 'video/mp4', 5, 5000)] },
        {
          id: 2,
          objectUrl: 'blob:active',
          buffers: [buffer(1, 'video/mp4', 8, 8000), buffer(2, 'audio/mp4', 4, 2000)],
        },
      ],
      2,
    ),
  );
  assert.equal(selected.mediaSourceId, 2);
  assert.equal(selected.video.id, 1);
  assert.equal(selected.audio.id, 2);
});

test('selectBuffers fails when the active MediaSource has no video buffer', () => {
  assert.throws(
    () =>
      selectBuffers(
        snapshot([{ id: 1, objectUrl: 'blob:1', buffers: [buffer(0, 'audio/mp4', 2, 200)] }], 1),
      ),
    (error) => error.code === 'no-video-buffer',
  );
});

test('selectBuffers fails on zero-byte video', () => {
  assert.throws(
    () => selectBuffers(snapshot([{ id: 1, objectUrl: null, buffers: [buffer(0, 'video/mp4', 0, 0)] }], 1)),
    (error) => error.code === 'empty-capture',
  );
});

test('selectBuffers fails on ambiguous equal-sized video buffers', () => {
  assert.throws(
    () =>
      selectBuffers(
        snapshot(
          [
            {
              id: 1,
              objectUrl: null,
              buffers: [buffer(0, 'video/mp4', 4, 4000), buffer(1, 'video/mp4', 4, 4000)],
            },
          ],
          1,
        ),
      ),
    (error) => error.code === 'ambiguous-buffer',
  );
});

test('selectBuffers picks the larger of two video buffers', () => {
  const selected = selectBuffers(
    snapshot(
      [
        {
          id: 1,
          objectUrl: null,
          buffers: [buffer(0, 'video/mp4', 4, 4000), buffer(1, 'video/mp4', 9, 9000)],
        },
      ],
      1,
    ),
  );
  assert.equal(selected.video.id, 1);
});

test('selectBuffers falls back to the video MediaSource when no active id is known', () => {
  const selected = selectBuffers(
    snapshot(
      [
        { id: 1, objectUrl: null, buffers: [buffer(0, 'audio/mp4', 2, 100)] },
        { id: 2, objectUrl: null, buffers: [buffer(1, 'video/mp4', 2, 100)] },
      ],
      null,
    ),
  );
  assert.equal(selected.mediaSourceId, 2);
});

// ---------------------------------------------------------------------------
// Ordered assembly
// ---------------------------------------------------------------------------

function memoryStream() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(callback) {
      callback();
    },
    once() {},
  };
}

test('OrderedWriter writes chunks in sequence order, not arrival order', () => {
  const stream = memoryStream();
  const writer = new OrderedWriter(stream);
  writer.push(2, Buffer.from('C'));
  writer.push(0, Buffer.from('A'));
  writer.push(1, Buffer.from('B'));
  assert.equal(Buffer.concat(stream.chunks).toString(), 'ABC');
  assert.equal(writer.chunksWritten, 3);
  assert.equal(writer.bytesWritten, 3);
});

test('OrderedWriter holds a gap until the missing chunk arrives', () => {
  const stream = memoryStream();
  const writer = new OrderedWriter(stream);
  writer.push(1, Buffer.from('B'));
  assert.equal(stream.chunks.length, 0);
  writer.push(0, Buffer.from('A'));
  assert.equal(Buffer.concat(stream.chunks).toString(), 'AB');
});

test('OrderedWriter ignores chunks after close', async () => {
  const stream = memoryStream();
  const writer = new OrderedWriter(stream);
  writer.push(0, Buffer.from('A'));
  await writer.close();
  writer.push(1, Buffer.from('B'));
  assert.equal(Buffer.concat(stream.chunks).toString(), 'A');
});

// ---------------------------------------------------------------------------
// Fragmented MP4 box inspection
// ---------------------------------------------------------------------------

function box(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

test('parseTopLevelBoxes reads box sizes and types', () => {
  const data = Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(10))]);
  const boxes = parseTopLevelBoxes(data);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'moov']);
});

test('inspectInitSegment accepts ftyp+moov before moof', () => {
  const data = Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]);
  const result = inspectInitSegment(data, { label: 'video' });
  assert.equal(result.hasInit, true);
  assert.equal(result.hasFragments, true);
});

test('inspectInitSegment rejects a stream that starts at the media fragment', () => {
  const data = Buffer.concat([box('moof'), box('mdat')]);
  assert.throws(
    () => inspectInitSegment(data, { label: 'video' }),
    (error) => error.code === 'capture-started-late',
  );
});

test('inspectInitSegment rejects an init-only stream with no fragments', () => {
  const data = Buffer.concat([box('ftyp'), box('moov')]);
  assert.throws(
    () => inspectInitSegment(data, { label: 'video' }),
    (error) => error.code === 'empty-capture',
  );
});

test('inspectInitSegment rejects a stream with no known boxes', () => {
  assert.throws(
    () => inspectInitSegment(Buffer.alloc(0)),
    (error) => error.code === 'empty-capture',
  );
});

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

test('deriveOutputPath prefers an explicit output path', () => {
  const result = deriveOutputPath({
    output: '~/Downloads/story.mp4',
    username: 'example',
    storyId: '123',
    cwd: '/base',
  });
  assert.match(result, /Downloads[/\\]story\.mp4$/);
});

test('deriveOutputPath builds username-storyId.mp4 by default', () => {
  const result = deriveOutputPath({ username: 'example', storyId: '123', cwd: '/base' });
  assert.equal(result, '/base/example-123.mp4');
});

test('deriveOutputPath builds username.mp4 when no story id is known', () => {
  const result = deriveOutputPath({ username: 'spilarii', storyId: null, cwd: '/base' });
  assert.equal(result, '/base/spilarii.mp4');
});

test('deriveOutputPath falls back to story.mp4', () => {
  const result = deriveOutputPath({ cwd: '/base' });
  assert.equal(result, '/base/story.mp4');
});

test('sanitizeComponent removes path separators and odd characters', () => {
  assert.equal(sanitizeComponent('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeComponent(''), 'story');
});

test('nextAvailablePath never returns an existing path', () => {
  const existing = new Set(['/base/story.mp4', '/base/story-1.mp4']);
  const result = nextAvailablePath('/base/story.mp4', (candidate) => existing.has(candidate));
  assert.equal(result, '/base/story-2.mp4');
});

test('nextAvailablePath returns the same path when free', () => {
  const result = nextAvailablePath('/base/story.mp4', () => false);
  assert.equal(result, '/base/story.mp4');
});

test('formatBytes formats human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.match(formatBytes(3_800_000), /MB/);
});

// ---------------------------------------------------------------------------
// FFmpeg command construction and validation
// ---------------------------------------------------------------------------

test('buildRemuxArgs maps video and audio with stream copy', () => {
  const args = buildRemuxArgs({
    videoPath: '/tmp/video.mp4',
    audioPath: '/tmp/audio.mp4',
    outputPath: '/out/story.mp4',
  });
  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    '/tmp/video.mp4',
    '-i',
    '/tmp/audio.mp4',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '/out/story.mp4',
  ]);
});

test('buildRemuxArgs handles a video-only remux', () => {
  const args = buildRemuxArgs({ videoPath: '/tmp/video.mp4', outputPath: '/out/story.mp4' });
  assert.deepEqual(args.slice(-5), ['-map', '0:v:0', '-c', 'copy', '/out/story.mp4']);
  assert.ok(!args.includes('1:a:0'));
});

test('validateProbe accepts one video and one audio stream', () => {
  const summary = validateProbe(
    {
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
      format: { duration: '3.0' },
    },
    { expectAudio: true },
  );
  assert.equal(summary.videoStreams, 1);
  assert.equal(summary.audioStreams, 1);
  assert.equal(summary.duration, 3);
});

test('validateProbe rejects a missing audio stream when audio is expected', () => {
  assert.throws(
    () =>
      validateProbe(
        { streams: [{ codec_type: 'video' }], format: { duration: '3.0' } },
        { expectAudio: true },
      ),
    (error) => error.code === 'invalid-output',
  );
});

test('validateProbe allows a missing audio stream when audio is not expected', () => {
  const summary = validateProbe(
    { streams: [{ codec_type: 'video' }], format: { duration: '3.0' } },
    { expectAudio: false },
  );
  assert.equal(summary.audioStreams, 0);
});

test('validateProbe rejects a zero-duration output', () => {
  assert.throws(
    () =>
      validateProbe(
        { streams: [{ codec_type: 'video' }], format: { duration: '0' } },
        { expectAudio: false },
      ),
    (error) => error.code === 'invalid-output',
  );
});

test('AppError carries a stable code', () => {
  const error = new AppError('timeout', 'nope');
  assert.equal(error.code, 'timeout');
  assert.ok(error instanceof Error);
});
