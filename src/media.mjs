/**
 * media.mjs — pure media logic.
 *
 * This module contains no browser and no process code. It classifies MIME
 * types, selects the correct SourceBuffer metadata, inspects fragmented MP4
 * boxes, and derives output paths. Because it is pure, it is fully unit
 * testable without Chromium, FFmpeg, or Instagram.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from './errors.mjs';

/** Lower-case the MIME type and strip any codec parameters. */
function baseMime(mime) {
  if (typeof mime !== 'string') return '';
  const semi = mime.indexOf(';');
  return (semi === -1 ? mime : mime.slice(0, semi)).trim().toLowerCase();
}

/**
 * Classify a MIME type only far enough to route it.
 * @param {string} mime
 * @returns {'video' | 'audio' | 'other'}
 */
export function classifyMime(mime) {
  const base = baseMime(mime);
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('audio/')) return 'audio';
  return 'other';
}

/** True when the MIME type is a fragmented-MP4 video track. */
export function isVideoMp4(mime) {
  return baseMime(mime).startsWith('video/mp4');
}

/** True when the MIME type is a fragmented-MP4 audio track. */
export function isAudioMp4(mime) {
  return baseMime(mime).startsWith('audio/mp4');
}

/** Human-readable byte size, for logs and diagnostics. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/**
 * Choose one buffer from a list of the same media kind.
 *
 * A single match is returned directly. With several matches we score by byte
 * count and then chunk count, which is the strongest signal available inside a
 * single MediaSource. If two buffers tie on both scores we refuse to guess and
 * fail with diagnostics instead of producing a random file.
 *
 * @param {Array<Record<string, any>>} list
 * @param {'video' | 'audio'} kind
 * @param {unknown} diagnostics
 */
function pickSingleBuffer(list, kind, diagnostics) {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const sorted = [...list].sort(
    (a, b) =>
      (b.byteCount ?? 0) - (a.byteCount ?? 0) ||
      (b.chunkCount ?? 0) - (a.chunkCount ?? 0) ||
      (a.order ?? 0) - (b.order ?? 0),
  );
  const [best, second] = sorted;
  const betterBytes = (best.byteCount ?? 0) > (second.byteCount ?? 0);
  const betterChunks = (best.chunkCount ?? 0) > (second.chunkCount ?? 0);
  if (betterBytes || betterChunks) return best;

  throw new AppError(
    'ambiguous-buffer',
    `Found ${list.length} ${kind}/mp4 SourceBuffers with equal size. Cannot choose one safely.`,
    { kind, buffers: sorted, diagnostics },
  );
}

/**
 * Select the video and audio buffers for the active Story.
 *
 * Selection is by MIME type and by MediaSource identity, never by numeric
 * SourceBuffer order. The caller supplies `activeMediaSourceId`, which is the
 * MediaSource referenced by the currently playing video element.
 *
 * @param {{
 *   activeMediaSourceId: number|null,
 *   mediaSources: Array<{ id: number, objectUrl: string|null, buffers: Array<Record<string, any>> }>,
 * }} snapshot
 * @param {{ debug?: boolean }} [options]
 * @returns {{ mediaSourceId: number, video: Record<string, any>, audio: Record<string, any>|null, diagnostics: unknown }}
 */
export function selectBuffers(snapshot, options = {}) {
  const mediaSources = snapshot?.mediaSources ?? [];
  const activeId = snapshot?.activeMediaSourceId ?? null;

  const diagnostics = mediaSources.map((ms) => ({
    id: ms.id,
    objectUrl: ms.objectUrl,
    buffers: (ms.buffers ?? []).map((b) => ({
      id: b.id,
      mime: b.mime,
      chunkCount: b.chunkCount,
      byteCount: b.byteCount,
      order: b.order,
    })),
  }));

  if (mediaSources.length === 0) {
    throw new AppError('no-video-buffer', 'No MediaSource was captured for this Story.', {
      diagnostics,
    });
  }

  let candidates;
  if (activeId !== null && activeId !== undefined) {
    candidates = mediaSources.filter((ms) => ms.id === activeId);
  } else {
    candidates = mediaSources.filter((ms) =>
      (ms.buffers ?? []).some((b) => isVideoMp4(b.mime)),
    );
  }

  if (candidates.length === 0) {
    throw new AppError('no-video-buffer', 'No video MediaSource was found for the active Story.', {
      diagnostics,
    });
  }
  if (candidates.length > 1) {
    throw new AppError(
      'ambiguous-buffer',
      'Several MediaSource objects could belong to this Story. Cannot choose one safely.',
      { diagnostics },
    );
  }

  const mediaSource = candidates[0];
  const buffers = mediaSource.buffers ?? [];
  const video = pickSingleBuffer(buffers.filter((b) => isVideoMp4(b.mime)), 'video', diagnostics);
  const audioList = buffers.filter((b) => isAudioMp4(b.mime));
  const audio =
    audioList.length === 0 ? null : pickSingleBuffer(audioList, 'audio', diagnostics);

  if (!video) {
    throw new AppError('no-video-buffer', 'The active Story has no video/mp4 SourceBuffer.', {
      diagnostics,
    });
  }
  if ((video.chunkCount ?? 0) === 0 || (video.byteCount ?? 0) === 0) {
    throw new AppError('empty-capture', 'The video SourceBuffer captured zero bytes.', {
      diagnostics,
    });
  }
  if (audio && ((audio.chunkCount ?? 0) === 0 || (audio.byteCount ?? 0) === 0)) {
    throw new AppError('empty-capture', 'The audio SourceBuffer captured zero bytes.', {
      diagnostics,
    });
  }

  if (options.debug) {
    // Returned metadata only; the CLI prints it.
  }

  return { mediaSourceId: mediaSource.id, video, audio, diagnostics };
}

/**
 * Parse the top-level ISO-BMFF boxes of a fragmented MP4 buffer.
 *
 * This is a shallow parser. It reads box sizes and types only. It supports the
 * 32-bit size, the 64-bit extended size (`size === 1`), and the
 * "extends to end of file" size (`size === 0`).
 *
 * @param {Buffer} buffer
 * @param {{ stopAtMoof?: boolean, maxBoxes?: number }} [options]
 * @returns {Array<{ type: string, size: number, offset: number, headerSize: number }>}
 */
export function parseTopLevelBoxes(buffer, options = {}) {
  const { stopAtMoof = false, maxBoxes = 64 } = options;
  const boxes = [];
  let offset = 0;

  while (offset + 8 <= buffer.length && boxes.length < maxBoxes) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      const high = buffer.readUInt32BE(offset + 8);
      const low = buffer.readUInt32BE(offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }

    boxes.push({ type, size, offset, headerSize });

    if (stopAtMoof && type === 'moof') break;
    if (size < headerSize) break; // malformed; stop rather than loop forever
    offset += size;
  }

  return boxes;
}

/**
 * Validate that a reconstructed stream starts with an initialization segment
 * (`ftyp`/`moov`) before its first media fragment (`moof`).
 *
 * @param {Buffer} head bytes read from the start of the reconstructed file
 * @param {{ label?: string }} [options]
 * @returns {{ boxes: string[], hasInit: boolean, hasFragments: boolean }}
 */
export function inspectInitSegment(head, options = {}) {
  const label = options.label ?? 'stream';
  const boxes = parseTopLevelBoxes(head, { stopAtMoof: true, maxBoxes: 1024 });
  const types = boxes.map((b) => b.type);
  const firstMoof = types.indexOf('moof');
  const moovIndex = types.indexOf('moov');
  const ftypIndex = types.indexOf('ftyp');

  const hasInit = moovIndex !== -1 && (firstMoof === -1 || moovIndex < firstMoof);

  if (!hasInit) {
    if (firstMoof !== -1) {
      throw new AppError(
        'capture-started-late',
        'Capture started after the media initialization segment.\nRetry with a fresh Story load.',
        { label, boxes: types },
      );
    }
    throw new AppError(
      'empty-capture',
      `The ${label} stream has no usable initialization segment (no moov box).`,
      { label, boxes: types, hasFtyp: ftypIndex !== -1 },
    );
  }

  if (firstMoof === -1) {
    throw new AppError(
      'empty-capture',
      `The ${label} stream has an initialization segment but no media fragments.`,
      { label, boxes: types },
    );
  }

  return { boxes: types, hasInit, hasFragments: true };
}

/** Expand a leading `~` to the user home directory. */
export function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * Turn an arbitrary string into a safe single path component.
 * @param {string} value
 * @param {string} [fallback]
 */
export function sanitizeComponent(value, fallback = 'story') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned || fallback;
}

/**
 * Derive the output path.
 *
 * A user-supplied `--output` always wins. Otherwise the name is
 * `<username>-<story-id>.mp4` when both parts are known, and `story.mp4`
 * otherwise.
 *
 * @param {{ output?: string|null, username?: string|null, storyId?: string|null, cwd?: string }} params
 */
export function deriveOutputPath(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  if (params.output) {
    return path.resolve(cwd, expandHome(params.output));
  }
  if (params.username && params.storyId) {
    return path.resolve(
      cwd,
      `${sanitizeComponent(params.username)}-${sanitizeComponent(params.storyId)}.mp4`,
    );
  }
  return path.resolve(cwd, 'story.mp4');
}

/**
 * Return a path that does not exist yet, by inserting `-1`, `-2`, ... before
 * the extension. Never overwrites silently.
 *
 * @param {string} target
 * @param {(candidate: string) => boolean} [exists]
 */
export function nextAvailablePath(target, exists = fs.existsSync) {
  if (!exists(target)) return target;
  const ext = path.extname(target);
  const base = ext ? target.slice(0, target.length - ext.length) : target;
  for (let i = 1; i < 100000; i += 1) {
    const candidate = `${base}-${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new AppError('invalid-output', `Cannot find a free filename near ${target}.`);
}
