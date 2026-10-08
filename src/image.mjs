/**
 * image.mjs — Story image support (scope A).
 *
 * Photos do not travel through Media Source Extensions, so they cannot be
 * captured like video. Instead, the page DOM exposes the signed CDN URL the
 * app chose. This module discovers that image, waits for it to settle, fetches
 * the exact bytes through the authenticated browser context, and saves them
 * unchanged.
 *
 * The pure helpers in this first section are unit-testable without a browser.
 * The page-driven functions are added in later slices.
 */

import path from 'node:path';

import { AppError } from './errors.mjs';
import { expandHome, sanitizeComponent } from './media.mjs';

/** Rendered images smaller than this are treated as icons, not Story media. */
const MIN_RENDERED_AREA = 160 * 160;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

const EXTENSIONS = Object.freeze({
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  heic: 'heic',
  avif: 'avif',
});

/**
 * Decode the `efg` query parameter of an Instagram CDN URL and return its
 * `vencode_tag`.
 *
 * The parameter is base64url-encoded JSON. The tag distinguishes media kinds,
 * for example "STORY..." for Story media and "profile_pic..." for avatars.
 * Returns null when the parameter is missing or malformed.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function decodeEncodeTag(url) {
  try {
    const parsed = new URL(url);
    const efg = parsed.searchParams.get('efg');
    if (!efg) return null;
    const normalized = efg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return typeof data?.vencode_tag === 'string' ? data.vencode_tag : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Parse a `srcset` attribute into candidate URLs.
 *
 * This is a pragmatic parser for CDN URLs. It splits on commas and reads `w`
 * and `x` descriptors. It does not support data URIs, which contain commas.
 *
 * @param {string} srcset
 * @returns {Array<{ url: string, width: number, density: number }>}
 */
export function parseSrcset(srcset) {
  if (typeof srcset !== 'string' || srcset.trim() === '') return [];
  const results = [];
  const pattern = /(?:^|,)\s*([^,\s]+)(?:\s+(\d+(?:\.\d+)?)([wx]))?/g;
  let match;
  while ((match = pattern.exec(srcset)) !== null) {
    const url = match[1];
    if (!url) continue;
    const value = match[2] === undefined ? null : Number(match[2]);
    const unit = match[3] ?? null;
    results.push({
      url,
      width: unit === 'w' ? value : 0,
      density: unit === 'x' ? value : value === null ? 1 : 0,
    });
  }
  return results;
}

/**
 * Detect an image type from magic bytes. The URL path is not trusted, because
 * a `.heic` path can deliver JPEG bytes.
 *
 * @param {Buffer} buffer
 * @returns {'jpeg'|'png'|'webp'|'gif'|'heic'|'avif'|null}
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';

  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  if (buffer.length >= 6) {
    const gif = buffer.toString('latin1', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  }

  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (AVIF_BRANDS.has(brand)) return 'avif';
  }

  return null;
}

/** Map a detected type to a file extension. */
export function extensionForType(type) {
  return EXTENSIONS[type] ?? null;
}

/**
 * Pick the best URL for a chosen candidate. Prefers the largest `w`
 * descriptor, then the largest `x` density above 1, then `currentSrc`.
 *
 * Precaution, not observed behavior: live evidence from one image Story showed
 * an empty `srcset` on every `<img>`, so this returns `currentSrc` there. Keep
 * this branch only while the `--debug` "srcset summary" line can report a
 * non-empty value; otherwise it is dead code and can be removed.
 *
 * @param {{ url?: string, srcset?: string }} candidate
 */
export function resolveBestImageUrl(candidate) {
  const fallback = candidate?.url ?? '';
  const entries = parseSrcset(candidate?.srcset ?? '');
  if (entries.length === 0) return fallback;

  const widths = entries.filter((entry) => entry.width > 0).sort((a, b) => b.width - a.width);
  if (widths.length > 0) return widths[0].url;

  const densities = entries
    .filter((entry) => entry.density > 1)
    .sort((a, b) => b.density - a.density);
  if (densities.length > 0) return densities[0].url;

  return fallback;
}

/** Strip the query string from a signed URL so logs never carry access tokens. */
export function sanitizeImageUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_error) {
    return '(unparseable url)';
  }
}

/**
 * Classify one candidate.
 * @returns {'invalid'|'profile'|'story'|'generic'}
 */
function candidateTier(candidate) {
  const tag = decodeEncodeTag(candidate?.url ?? '') ?? '';
  const usable =
    candidate?.visible === true &&
    (candidate?.naturalWidth ?? 0) > 0 &&
    (candidate?.naturalHeight ?? 0) > 0 &&
    (candidate?.renderedWidth ?? 0) * (candidate?.renderedHeight ?? 0) >= MIN_RENDERED_AREA;
  if (!usable) return 'invalid';
  if (tag.toLowerCase().includes('profile_pic')) return 'profile';
  if (tag.toUpperCase().includes('STORY') || /[?&]ig_cache_key=/.test(candidate.url ?? '')) {
    return 'story';
  }
  return 'generic';
}

/**
 * Choose the active Story image from the page snapshot.
 *
 * Identity comes from the `efg` tag and geometry, not from DOM order. Avatars
 * are rejected outright. Tagged Story media wins over untagged candidates.
 * Within a tier, the largest rendered item wins, then the largest natural
 * resolution, then the most recently changed one.
 *
 * @param {Array<Record<string, any>>} candidates
 * @param {{ debug?: boolean }} [options]
 * @returns {{ chosen: Record<string, any>|null, tier: 'story'|'generic'|'none', diagnostics: Array<Record<string, any>> }}
 */
export function selectStoryImage(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const diagnostics = list.map((candidate) => ({
    id: candidate.id,
    tier: candidateTier(candidate),
    url: sanitizeImageUrl(candidate.url ?? ''),
    natural: `${candidate.naturalWidth ?? 0}x${candidate.naturalHeight ?? 0}`,
    rendered: `${candidate.renderedWidth ?? 0}x${candidate.renderedHeight ?? 0}`,
    visible: !!candidate.visible,
    lastSrcChangeAt: candidate.lastSrcChangeAt ?? 0,
    srcsetEmpty: !(candidate.srcset ?? '').trim(),
    srcsetEntries: parseSrcset(candidate.srcset ?? '').length,
  }));

  const story = list.filter((candidate) => candidateTier(candidate) === 'story');
  const generic = list.filter((candidate) => candidateTier(candidate) === 'generic');
  const pool = story.length > 0 ? story : generic;

  if (pool.length === 0) {
    return { chosen: null, tier: 'none', diagnostics };
  }

  const sorted = [...pool].sort(
    (a, b) =>
      (b.renderedWidth ?? 0) * (b.renderedHeight ?? 0) -
        (a.renderedWidth ?? 0) * (a.renderedHeight ?? 0) ||
      (b.naturalWidth ?? 0) * (b.naturalHeight ?? 0) -
        (a.naturalWidth ?? 0) * (a.naturalHeight ?? 0) ||
      (b.lastSrcChangeAt ?? 0) - (a.lastSrcChangeAt ?? 0),
  );

  return { chosen: sorted[0], tier: story.length > 0 ? 'story' : 'generic', diagnostics };
}

/**
 * Derive the output path for a Story image.
 *
 * A user-supplied `--output` wins. When it has no extension, the detected
 * extension is appended. Otherwise the name is `<username>-<story-id>.<ext>`.
 *
 * @param {{ output?: string|null, username?: string|null, storyId?: string|null, extension: string, cwd?: string }} params
 */
export function deriveImageOutputPath(params) {
  const cwd = params.cwd ?? process.cwd();
  const extension = sanitizeComponent(String(params.extension ?? 'jpg').replace(/^\./, ''), 'jpg');
  if (params.output) {
    const resolved = path.resolve(cwd, expandHome(params.output));
    return path.extname(resolved) ? resolved : `${resolved}.${extension}`;
  }
  const base =
    params.username && params.storyId
      ? `${sanitizeComponent(params.username)}-${sanitizeComponent(params.storyId)}`
      : 'story';
  return path.resolve(cwd, `${base}.${extension}`);
}

/**
 * True when an explicit output extension contradicts the detected image type.
 * `jpg` and `jpeg` are treated as the same extension.
 */
export function extensionConflicts(filePath, type) {
  const declared = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (!declared) return false;
  const expected = extensionForType(type);
  if (!expected) return false;
  if (declared === expected) return false;
  if ((declared === 'jpg' || declared === 'jpeg') && (expected === 'jpg' || expected === 'jpeg')) {
    return false;
  }
  return true;
}

function signatureOf(candidate) {
  return `${candidate.url}|${candidate.naturalWidth}x${candidate.naturalHeight}|${
    candidate.complete ? 1 : 0
  }`;
}

function finalizeCandidate(candidate) {
  return { ...candidate, bestUrl: resolveBestImageUrl(candidate) };
}

/**
 * Print the candidate table and a grep-friendly srcset summary in debug mode.
 * The summary is the evidence used to decide whether the srcset branch is
 * worth keeping.
 */
function logImageCandidates(log, diagnostics) {
  for (const line of diagnostics) {
    log(
      `[image] candidate id=${line.id} tier=${line.tier} visible=${line.visible} natural=${line.natural} rendered=${line.rendered} srcset=${
        line.srcsetEmpty ? 'empty' : `${line.srcsetEntries} entries`
      } recency=${line.lastSrcChangeAt} url=${line.url}`,
    );
  }
  const empty = diagnostics.filter((line) => line.srcsetEmpty).length;
  log(
    `[image] srcset summary: total=${diagnostics.length} empty=${empty} nonEmpty=${
      diagnostics.length - empty
    }`,
  );
}

/**
 * Lock the active Story image and wait until it settles.
 *
 * Locking by registry id is what prevents a switch to the next carousel item.
 * Settling avoids saving a placeholder that Instagram upgrades in place.
 *
 * @param {import('playwright').Page} page
 * @param {{ timeoutMs?: number, quietMs?: number, pollMs?: number, log?: Function, debug?: boolean }} [options]
 */
export async function lockAndSettleStoryImage(page, options = {}) {
  const {
    timeoutMs = 30000,
    quietMs = 1000,
    pollMs = 200,
    log = () => {},
    debug = false,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let locked = null;
  let lastSignature = '';
  let quietSince = 0;

  while (Date.now() < deadline) {
    const candidates = await page.evaluate(() =>
      typeof window.__snapstorySnapshotImages === 'function'
        ? window.__snapstorySnapshotImages()
        : [],
    );

    if (!locked) {
      const selection = selectStoryImage(candidates);
      if (!selection.chosen) {
        await page.waitForTimeout(pollMs);
        continue;
      }
      locked = selection.chosen;
      lastSignature = signatureOf(locked);
      quietSince = Date.now();
      if (debug) {
        logImageCandidates(log, selection.diagnostics);
        log(
          `[image] locked candidate id=${locked.id} tier=${selection.tier} ${sanitizeImageUrl(
            locked.url,
          )}`,
        );
      }
    }

    const current = candidates.find((candidate) => candidate.id === locked.id);
    if (current) {
      const signature = signatureOf(current);
      if (signature !== lastSignature) {
        lastSignature = signature;
        quietSince = Date.now();
        locked = current;
      } else if (current.complete && Date.now() - quietSince >= quietMs) {
        return finalizeCandidate(current);
      }
    } else {
      // The Story advanced. Return the last good candidate, never the next item.
      return finalizeCandidate(locked);
    }

    await page.waitForTimeout(pollMs);
  }

  if (locked) return finalizeCandidate(locked);
  throw new AppError('no-media', 'No Story image was found.');
}

/**
 * Fetch the image bytes through the authenticated browser context. Reusing the
 * context is what carries cookies and TLS; no authentication is re-implemented.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 */
export async function fetchImage(context, url, options = {}) {
  const { timeoutMs = 30000, maxBytes = 32 * 1024 * 1024 } = options;

  if (typeof url !== 'string' || url === '') {
    throw new AppError('invalid-image', 'The Story image URL is empty.');
  }
  if (url.startsWith('blob:')) {
    throw new AppError(
      'invalid-image',
      'The Story image is exposed as a blob URL. This variant is not supported.',
      { url: sanitizeImageUrl(url) },
    );
  }

  let response;
  try {
    response = await context.request.get(url, {
      timeout: timeoutMs,
      failOnStatusCode: false,
      headers: {
        referer: 'https://www.instagram.com/',
        accept: 'image/*,*/*;q=0.8',
      },
    });
  } catch (error) {
    throw new AppError('image-fetch-failed', `Could not download the Story image: ${error.message}`);
  }

  if (!response.ok()) {
    throw new AppError(
      'image-fetch-failed',
      `Could not download the Story image (HTTP ${response.status()}). The signed URL may have expired; retry.`,
      { status: response.status() },
    );
  }

  const bytes = Buffer.from(await response.body());
  if (bytes.length === 0) {
    throw new AppError('invalid-image', 'The downloaded Story image is empty.');
  }
  if (bytes.length > maxBytes) {
    throw new AppError('invalid-image', `The downloaded Story image exceeds ${maxBytes} bytes.`, {
      bytes: bytes.length,
    });
  }

  return {
    bytes,
    contentType: response.headers()['content-type'] ?? null,
    status: response.status(),
  };
}

/**
 * Full image acquisition: lock, settle, fetch, and detect the type.
 *
 * @returns {Promise<{ bytes: Buffer, type: string, extension: string, url: string, status: number, contentType: string|null, naturalWidth: number, naturalHeight: number }>}
 */
export async function downloadStoryImage(context, page, options = {}) {
  const candidate = await lockAndSettleStoryImage(page, options);
  const url = candidate.bestUrl || candidate.url;
  const { bytes, contentType, status } = await fetchImage(context, url, options);
  const type = detectImageType(bytes);

  if (!type) {
    throw new AppError(
      'invalid-image',
      'The downloaded Story image is empty or has an unknown format.',
      { status, contentType, bytes: bytes.length },
    );
  }

  return {
    bytes,
    type,
    extension: extensionForType(type),
    url,
    status,
    contentType,
    naturalWidth: candidate.naturalWidth,
    naturalHeight: candidate.naturalHeight,
  };
}
