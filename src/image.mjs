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
