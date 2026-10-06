/**
 * capture.mjs — Media Source Extensions capture.
 *
 * Two halves live here:
 *
 *   1. The page-side interceptor. It is injected with `addInitScript` before
 *      any Instagram code runs, so it patches `MediaSource.prototype` and
 *      `SourceBuffer.prototype` before the Story creates its buffers.
 *
 *   2. The Node-side receiver. It receives metadata events and base64 media
 *      chunks over Playwright bindings and writes each SourceBuffer to its own
 *      temporary file in exact append order.
 *
 * Binary transfer avoids Array<number>: the page converts each appendBuffer
 * payload to one base64 string, and Node decodes it with Buffer.from(...,
 * 'base64'). No per-byte Number objects are created on either side.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AppError } from './errors.mjs';
import { classifyMime } from './media.mjs';

/**
 * The page-side interceptor, written as a normal function so the source stays
 * readable and lintable. It is serialized with `Function.prototype.toString`
 * and wrapped in an IIFE. It must be fully self-contained: no outer imports.
 */
function mseInterceptor() {
  'use strict';

  const pageToken = `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const capture = {
    pageToken,
    nextMediaSourceId: 0,
    nextSourceBufferId: 0,
    nextOrder: 0,
    mediaSources: new Map(), // MediaSource -> { id, objectUrl, buffers: Set<SourceBuffer> }
    buffers: new Map(), // SourceBuffer -> metadata
    objectUrls: new Map(), // blob URL string -> MediaSource
  };
  window.__mseCapture = capture;

  const emit = (payload) => {
    try {
      const fn = window.__mseEvent;
      if (typeof fn === 'function') fn({ ...payload, pageToken });
    } catch (_error) {
      /* never let reporting break playback */
    }
  };

  const ensureMediaSource = (mediaSource, objectUrl) => {
    let meta = capture.mediaSources.get(mediaSource);
    if (!meta) {
      meta = { id: capture.nextMediaSourceId++, objectUrl: objectUrl ?? null, buffers: new Set() };
      capture.mediaSources.set(mediaSource, meta);
      emit({ type: 'media-source', id: meta.id, objectUrl: meta.objectUrl });
    } else if (objectUrl && !meta.objectUrl) {
      meta.objectUrl = objectUrl;
      emit({ type: 'media-source-url', id: meta.id, objectUrl });
    }
    return meta;
  };

  // 1. Track the blob URL that a MediaSource receives. This is the link used
  //    later to associate the active <video> with its MediaSource.
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (object) {
      const url = originalCreateObjectURL(object);
      try {
        if (typeof MediaSource !== 'undefined' && object instanceof MediaSource) {
          const meta = ensureMediaSource(object, url);
          capture.objectUrls.set(url, object);
          emit({ type: 'object-url', id: meta.id, objectUrl: url });
        }
      } catch (_error) {
        /* ignore */
      }
      return url;
    };
  }

  // 2. Track every SourceBuffer and its MIME type, never its numeric order.
  if (typeof MediaSource !== 'undefined' && MediaSource.prototype) {
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    if (typeof originalAddSourceBuffer === 'function') {
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sourceBuffer = originalAddSourceBuffer.call(this, mime);
        const mediaSourceMeta = ensureMediaSource(this, null);
        const meta = {
          id: capture.nextSourceBufferId++,
          mediaSourceId: mediaSourceMeta.id,
          mime,
          order: capture.nextOrder++,
          sequence: 0,
          chunkCount: 0,
          byteCount: 0,
          lastAppendAt: 0,
        };
        capture.buffers.set(sourceBuffer, meta);
        mediaSourceMeta.buffers.add(sourceBuffer);
        emit({
          type: 'source-buffer',
          id: meta.id,
          mediaSourceId: meta.mediaSourceId,
          mime,
          order: meta.order,
        });
        return sourceBuffer;
      };
    }
  }

  // 3. Capture appendBuffer bytes. Copy synchronously so the bytes cannot be
  //    mutated or pooled by the caller after the call returns. Call the
  //    original immediately so playback timing does not change.
  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype) {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    if (typeof originalAppendBuffer === 'function') {
      SourceBuffer.prototype.appendBuffer = function (data) {
        const meta = capture.buffers.get(this);
        const copy = meta ? copyBytes(data) : null;
        const result = originalAppendBuffer.call(this, data);
        if (meta && copy && copy.byteLength > 0) {
          const sequence = meta.sequence++;
          meta.chunkCount++;
          meta.byteCount += copy.byteLength;
          meta.lastAppendAt = Date.now();
          enqueue(meta.id, meta.mediaSourceId, meta.mime, sequence, copy);
        }
        return result;
      };
    }
  }

  function copyBytes(data) {
    if (data instanceof ArrayBuffer) return data.slice(0);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return null;
  }

  function toBase64(bytes) {
    let binary = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
    }
    return btoa(binary);
  }

  const pending = [];
  let scheduled = false;

  function enqueue(sourceBufferId, mediaSourceId, mime, sequence, bytes) {
    pending.push({ sourceBufferId, mediaSourceId, mime, sequence, bytes });
    if (scheduled) return;
    scheduled = true;
    // Yield to the browser first: appendBuffer already ran synchronously.
    setTimeout(drain, 0);
  }

  function drain() {
    scheduled = false;
    const item = pending.shift();
    if (item) {
      let base64 = null;
      try {
        base64 = toBase64(new Uint8Array(item.bytes));
      } catch (_error) {
        base64 = null;
      }
      if (base64 !== null) {
        try {
          const send = window.__mseChunk;
          if (typeof send === 'function') {
            send({
              pageToken,
              sourceBufferId: item.sourceBufferId,
              mediaSourceId: item.mediaSourceId,
              mime: item.mime,
              sequence: item.sequence,
              base64,
            });
          }
        } catch (_error) {
          /* ignore */
        }
      }
      if (pending.length > 0) {
        scheduled = true;
        setTimeout(drain, 0);
      }
    }
  }

  // 4. Normalized snapshot for the Node side. Native objects stay in the page.
  window.__mseSnapshot = function () {
    const videos = [];
    let activeMediaSourceId = null;
    let activeScore = -Infinity;

    const elements = Array.from(document.querySelectorAll('video'));
    for (const element of elements) {
      const src = element.currentSrc || element.src || '';
      const mediaSource = capture.objectUrls.get(src) || null;
      const meta = mediaSource ? capture.mediaSources.get(mediaSource) : null;
      let visible = false;
      try {
        const rect = element.getBoundingClientRect();
        visible = rect.width > 8 && rect.height > 8;
      } catch (_error) {
        visible = false;
      }
      let score = 0;
      if (!element.paused) score += 4;
      if (element.currentTime > 0) score += 3;
      if (visible) score += 2;
      if (element.readyState >= 2) score += 1;
      if (element.ended) score -= 2;

      videos.push({
        currentSrc: src,
        mediaSourceId: meta ? meta.id : null,
        duration: Number.isFinite(element.duration) ? element.duration : null,
        currentTime: element.currentTime,
        paused: element.paused,
        ended: element.ended,
        muted: element.muted,
        readyState: element.readyState,
        visible,
        score,
      });

      if (meta && score > activeScore) {
        activeScore = score;
        activeMediaSourceId = meta.id;
      }
    }

    const mediaSources = [];
    for (const [mediaSource, meta] of capture.mediaSources) {
      const buffers = [];
      for (const sourceBuffer of meta.buffers) {
        const bufferMeta = capture.buffers.get(sourceBuffer);
        if (!bufferMeta) continue;
        let bufferedEnd = null;
        try {
          if (sourceBuffer.buffered && sourceBuffer.buffered.length > 0) {
            bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          }
        } catch (_error) {
          bufferedEnd = null;
        }
        buffers.push({
          id: bufferMeta.id,
          mediaSourceId: bufferMeta.mediaSourceId,
          mime: bufferMeta.mime,
          order: bufferMeta.order,
          chunkCount: bufferMeta.chunkCount,
          byteCount: bufferMeta.byteCount,
          lastAppendAt: bufferMeta.lastAppendAt,
          updating: !!sourceBuffer.updating,
          bufferedEnd,
          readyState: typeof sourceBuffer.readyState === 'number' ? sourceBuffer.readyState : null,
        });
      }
      mediaSources.push({ id: meta.id, objectUrl: meta.objectUrl, buffers });
    }

    return { pageToken, mediaSources, videos, activeMediaSourceId };
  };

  window.__msePendingCount = function () {
    return pending.length;
  };
}

/** The interceptor source, wrapped as an IIFE for `addInitScript`. */
export const INIT_SCRIPT = `(${mseInterceptor.toString()})();`;

/**
 * Writes chunks to a stream in sequence order.
 *
 * IPC completion order is not guaranteed. The page assigns a sequence number
 * before transfer; this writer buffers out-of-order arrivals and flushes them
 * in order. This is a Reordering Buffer.
 */
export class OrderedWriter {
  /** @param {{ write(chunk: Buffer): unknown, end(callback: () => void): unknown, once(event: string, listener: (...args: any[]) => void): unknown }} stream */
  constructor(stream) {
    this.stream = stream;
    this.nextSequence = 0;
    this.pending = new Map();
    this.bytesWritten = 0;
    this.chunksWritten = 0;
    this.ended = false;
    this.closed = null;
  }

  /**
   * Accept a chunk with its sequence number.
   * @param {number} sequence
   * @param {Buffer} buffer
   */
  push(sequence, buffer) {
    if (this.ended) return;
    this.pending.set(sequence, buffer);
    while (this.pending.has(this.nextSequence)) {
      const chunk = this.pending.get(this.nextSequence);
      this.pending.delete(this.nextSequence);
      this.stream.write(chunk);
      this.bytesWritten += chunk.length;
      this.chunksWritten += 1;
      this.nextSequence += 1;
    }
  }

  /** Flush and close the stream. Resolves when the stream is finished. */
  close() {
    if (this.ended) return this.closed;
    this.ended = true;
    this.closed = new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(() => resolve());
    });
    return this.closed;
  }
}

/**
 * Node-side receiver.
 *
 * Exposed on the browser context so the interceptor can report before any
 * navigation. Metadata and media bytes travel over separate bindings to keep
 * the fast path small.
 */
export class CaptureReceiver {
  constructor({ workDir, debug = false, log = () => {} }) {
    if (!workDir) throw new Error('CaptureReceiver requires a workDir');
    this.workDir = workDir;
    this.debug = debug;
    this.log = log;
    this.mediaSources = new Map();
    this.buffers = new Map();
    this.writers = [];
  }

  /** Install the two bindings on a Playwright browser context. */
  async attach(context) {
    await context.exposeBinding('__mseEvent', (_source, payload) => this.#onEvent(payload));
    await context.exposeBinding('__mseChunk', (_source, payload) => this.#onChunk(payload));
  }

  #onEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const pageToken = payload.pageToken;

    if (
      payload.type === 'media-source' ||
      payload.type === 'media-source-url' ||
      payload.type === 'object-url'
    ) {
      const key = `${pageToken}:${payload.id}`;
      const existing = this.mediaSources.get(key) ?? {};
      this.mediaSources.set(key, {
        ...existing,
        id: payload.id,
        pageToken,
        objectUrl: payload.objectUrl ?? existing.objectUrl ?? null,
      });
      if (this.debug) this.log(`[capture] MediaSource ${payload.id} url=${payload.objectUrl ?? '-'}`);
      return;
    }

    if (payload.type === 'source-buffer') {
      const kind = classifyMime(payload.mime);
      const extension = kind === 'other' ? 'bin' : 'mp4';
      const file = path.join(this.workDir, `${kind}-${payload.id}.${extension}`);
      const stream = fs.createWriteStream(file);
      const writer = new OrderedWriter(stream);
      this.buffers.set(`${pageToken}:${payload.id}`, {
        id: payload.id,
        pageToken,
        mediaSourceId: payload.mediaSourceId,
        mime: payload.mime,
        order: payload.order,
        path: file,
        writer,
      });
      this.writers.push(writer);
      if (this.debug) this.log(`[capture] SourceBuffer ${payload.id} mime=${payload.mime}`);
    }
  }

  #onChunk(payload) {
    if (!payload || typeof payload !== 'object') return;
    const entry = this.buffers.get(`${payload.pageToken}:${payload.sourceBufferId}`);
    if (!entry) return;
    const bytes = Buffer.from(payload.base64 ?? '', 'base64');
    entry.writer.push(payload.sequence, bytes);
  }

  /** Flush and close every writer. */
  async finalize() {
    await Promise.all(this.writers.map((writer) => writer.close()));
  }

  /** Normalized metadata for selection, including temp file paths. */
  snapshot() {
    return {
      buffers: Array.from(this.buffers.values()).map((entry) => ({
        id: entry.id,
        pageToken: entry.pageToken,
        mediaSourceId: entry.mediaSourceId,
        mime: entry.mime,
        order: entry.order,
        chunkCount: entry.writer.chunksWritten,
        byteCount: entry.writer.bytesWritten,
        path: entry.path,
      })),
      mediaSources: Array.from(this.mediaSources.values()),
    };
  }
}

/**
 * Join the page-side snapshot (playback, active MediaSource) with the
 * Node-side snapshot (temp file paths, byte totals).
 *
 * @param {import('playwright').Page} page
 * @param {CaptureReceiver} receiver
 * @returns {Promise<{ pageToken: string, mediaSources: any[], videos: any[], activeMediaSourceId: number|null }>}
 */
export async function collectSnapshot(page, receiver) {
  const pageSnapshot = await page.evaluate(() =>
    typeof window.__mseSnapshot === 'function' ? window.__mseSnapshot() : null,
  );
  if (!pageSnapshot) {
    throw new AppError(
      'capture-failed',
      'The capture interceptor is not installed in the page. This should not happen.',
    );
  }

  const receiverSnapshot = receiver.snapshot();
  const byKey = new Map(
    receiverSnapshot.buffers.map((b) => [`${b.pageToken}:${b.id}`, b]),
  );

  const mediaSources = pageSnapshot.mediaSources.map((ms) => ({
    id: ms.id,
    objectUrl: ms.objectUrl,
    buffers: ms.buffers.map((b) => {
      const recorded = byKey.get(`${pageSnapshot.pageToken}:${b.id}`);
      return { ...b, path: recorded?.path ?? null };
    }),
  }));

  return {
    pageToken: pageSnapshot.pageToken,
    mediaSources,
    videos: pageSnapshot.videos,
    activeMediaSourceId: pageSnapshot.activeMediaSourceId,
  };
}

/** Wait until the page's transfer queue is empty. */
export async function waitForPendingDrain(page, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let count = 0;
    try {
      count = await page.evaluate(() =>
        typeof window.__msePendingCount === 'function' ? window.__msePendingCount() : 0,
      );
    } catch (_error) {
      return;
    }
    if (count === 0) return;
    await page.waitForTimeout(intervalMs);
  }
}
