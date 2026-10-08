/**
 * image.test.mjs — unit tests for the pure Story image helpers.
 * No browser, no FFmpeg, no Instagram.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeEncodeTag,
  deriveImageOutputPath,
  detectImageType,
  extensionConflicts,
  extensionForType,
  redactImageUrls,
  sanitizeImageUrl,
  selectStoryImage,
} from '../src/image.mjs';

function encodeTag(value) {
  return Buffer.from(JSON.stringify({ vencode_tag: value }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function taggedUrl(tag, extra = '') {
  return `https://instagram.fmcz2-1.fna.fbcdn.net/v/t51.82787-15/photo.jpg?stp=dst-jpg_e35_p320x320&efg=${encodeTag(
    tag,
  )}${extra}&oh=00&oe=6A`;
}

function candidate(overrides = {}) {
  return {
    id: 1,
    url: 'https://cdn.example/photo.jpg',
    naturalWidth: 800,
    naturalHeight: 1000,
    renderedWidth: 400,
    renderedHeight: 500,
    visible: true,
    complete: true,
    insertedAt: 0,
    lastSrcChangeAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decodeEncodeTag
// ---------------------------------------------------------------------------

test('decodeEncodeTag reads a Story vencode_tag', () => {
  assert.equal(
    decodeEncodeTag(taggedUrl('STORY.xpids.1440.sdr.regular_photo.C3')),
    'STORY.xpids.1440.sdr.regular_photo.C3',
  );
});

test('decodeEncodeTag reads a profile_pic vencode_tag', () => {
  assert.equal(decodeEncodeTag(taggedUrl('profile_pic.django.1080.c2')), 'profile_pic.django.1080.c2');
});

test('decodeEncodeTag returns null without efg', () => {
  assert.equal(decodeEncodeTag('https://cdn.example/photo.jpg'), null);
});

test('decodeEncodeTag returns null on malformed efg', () => {
  assert.equal(decodeEncodeTag('https://cdn.example/photo.jpg?efg=%%%'), null);
});

test('decodeEncodeTag returns null when vencode_tag is absent', () => {
  const efg = Buffer.from(JSON.stringify({ other: true }), 'utf8')
    .toString('base64')
    .replace(/=+$/, '');
  assert.equal(decodeEncodeTag(`https://cdn.example/photo.jpg?efg=${efg}`), null);
});

// ---------------------------------------------------------------------------
// detectImageType / extensionForType
// ---------------------------------------------------------------------------

test('detectImageType recognises jpeg', () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'jpeg');
});

test('detectImageType recognises png', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR'),
  ]);
  assert.equal(detectImageType(png), 'png');
});

test('detectImageType recognises webp', () => {
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
  ]);
  assert.equal(detectImageType(webp), 'webp');
});

test('detectImageType recognises gif', () => {
  assert.equal(detectImageType(Buffer.from('GIF89a----')), 'gif');
});

test('detectImageType recognises heic and avif ftyp brands', () => {
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(4)]);
  const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)]);
  assert.equal(detectImageType(heic), 'heic');
  assert.equal(detectImageType(avif), 'avif');
});

function ftypBuffer(major, compatible = []) {
  const brands = Buffer.from(compatible.join(''), 'latin1');
  const size = 16 + brands.length;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(size, 0);
  header.write('ftyp', 4, 'latin1');
  header.write(major, 8, 'latin1');
  return Buffer.concat([header, brands]);
}

test('detectImageType reads compatible brands for generic major brands', () => {
  assert.equal(detectImageType(ftypBuffer('mif1', ['mif1'])), 'heic');
  assert.equal(detectImageType(ftypBuffer('mif1', ['avif', 'mif1'])), 'avif');
  assert.equal(detectImageType(ftypBuffer('msf1', ['heic', 'mif1'])), 'heic');
  assert.equal(detectImageType(ftypBuffer('heic', ['mif1', 'heic'])), 'heic');
  assert.equal(detectImageType(ftypBuffer('zzzz', ['zzzz'])), null);
});

test('detectImageType returns null for unknown bytes', () => {
  assert.equal(detectImageType(Buffer.from('not an image at all')), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test('extensionForType maps every type', () => {
  assert.equal(extensionForType('jpeg'), 'jpg');
  assert.equal(extensionForType('png'), 'png');
  assert.equal(extensionForType('webp'), 'webp');
  assert.equal(extensionForType('gif'), 'gif');
  assert.equal(extensionForType('heic'), 'heic');
  assert.equal(extensionForType('avif'), 'avif');
  assert.equal(extensionForType('nope'), null);
});

// ---------------------------------------------------------------------------
// sanitizeImageUrl
// ---------------------------------------------------------------------------

test('sanitizeImageUrl removes the signed query string', () => {
  const safe = sanitizeImageUrl('https://host.example/v/t51/photo.jpg?oh=secret&oe=123');
  assert.equal(safe, 'https://host.example/v/t51/photo.jpg');
});

test('sanitizeImageUrl shortens data and blob URLs', () => {
  assert.equal(sanitizeImageUrl('data:image/png;base64,AAAA'), '(data URL)');
  assert.equal(sanitizeImageUrl('blob:https://www.instagram.com/abc'), '(blob URL)');
});

test('redactImageUrls removes signed queries from free text', () => {
  const text =
    'apiRequestContext.get: Timeout 30000ms exceeded. GET https://host.example/p/photo.jpg?oh=secret&oe=123 failed';
  const redacted = redactImageUrls(text);
  assert.equal(redacted.includes('oh=secret'), false);
  assert.equal(redacted.includes('https://host.example/p/photo.jpg'), true);
});

test('sanitizeImageUrl handles unparseable input', () => {
  assert.equal(sanitizeImageUrl('not a url'), '(unparseable url)');
});

// ---------------------------------------------------------------------------
// selectStoryImage
// ---------------------------------------------------------------------------

test('selectStoryImage rejects the avatar and picks the Story image', () => {
  const avatar = candidate({
    id: 1,
    url: taggedUrl('profile_pic.django.1080.c2'),
    naturalWidth: 800,
    naturalHeight: 800,
    renderedWidth: 500,
    renderedHeight: 500,
  });
  const story = candidate({
    id: 2,
    url: taggedUrl('STORY.xpids.1440.sdr.regular_photo.C3'),
    naturalWidth: 400,
    naturalHeight: 400,
    renderedWidth: 400,
    renderedHeight: 400,
  });
  const result = selectStoryImage([avatar, story]);
  assert.equal(result.chosen.id, 2);
  assert.equal(result.tier, 'story');
});

test('selectStoryImage prefers tagged Story media over a larger generic image', () => {
  const generic = candidate({
    id: 1,
    renderedWidth: 900,
    renderedHeight: 900,
    naturalWidth: 900,
    naturalHeight: 900,
  });
  const story = candidate({
    id: 2,
    url: taggedUrl('STORY.xpids.1440.sdr.regular_photo.C3'),
    renderedWidth: 300,
    renderedHeight: 400,
  });
  const result = selectStoryImage([generic, story]);
  assert.equal(result.chosen.id, 2);
  assert.equal(result.tier, 'story');
});

test('selectStoryImage treats ig_cache_key as a Story signal', () => {
  const generic = candidate({ id: 1, renderedWidth: 900, renderedHeight: 900 });
  const tagged = candidate({ id: 2, url: 'https://cdn.example/photo.jpg?ig_cache_key=abc' });
  const result = selectStoryImage([generic, tagged]);
  assert.equal(result.chosen.id, 2);
  assert.equal(result.tier, 'story');
});

test('selectStoryImage rejects invisible candidates', () => {
  const invisible = candidate({ id: 1, visible: false });
  const result = selectStoryImage([invisible]);
  assert.equal(result.chosen, null);
  assert.equal(result.tier, 'none');
});

test('selectStoryImage rejects tiny candidates', () => {
  const tiny = candidate({ id: 1, renderedWidth: 32, renderedHeight: 32 });
  const result = selectStoryImage([tiny]);
  assert.equal(result.chosen, null);
});

test('selectStoryImage picks the largest rendered candidate inside a tier', () => {
  const small = candidate({ id: 1, renderedWidth: 300, renderedHeight: 300 });
  const large = candidate({ id: 2, renderedWidth: 500, renderedHeight: 500 });
  const result = selectStoryImage([small, large]);
  assert.equal(result.chosen.id, 2);
});

test('selectStoryImage breaks ties by recency', () => {
  const older = candidate({ id: 1, lastSrcChangeAt: 10 });
  const newer = candidate({ id: 2, lastSrcChangeAt: 20 });
  const result = selectStoryImage([older, newer]);
  assert.equal(result.chosen.id, 2);
});

test('selectStoryImage returns none when every candidate is invalid', () => {
  const result = selectStoryImage([
    candidate({ id: 1, naturalWidth: 0, naturalHeight: 0 }),
    candidate({ id: 2, visible: false }),
  ]);
  assert.equal(result.chosen, null);
  assert.equal(result.diagnostics.length, 2);
});

// ---------------------------------------------------------------------------
// deriveImageOutputPath / extensionConflicts
// ---------------------------------------------------------------------------

test('deriveImageOutputPath builds username-storyId.ext by default', () => {
  const result = deriveImageOutputPath({
    username: 'example',
    storyId: '123',
    extension: 'jpg',
    cwd: '/base',
  });
  assert.equal(result, '/base/example-123.jpg');
});

test('deriveImageOutputPath falls back to username.ext without a story id', () => {
  const result = deriveImageOutputPath({ username: 'spilarii', extension: 'jpg', cwd: '/base' });
  assert.equal(result, '/base/spilarii.jpg');
});

test('deriveImageOutputPath falls back to story.ext', () => {
  const result = deriveImageOutputPath({ extension: 'png', cwd: '/base' });
  assert.equal(result, '/base/story.png');
});

test('deriveImageOutputPath honours an explicit output with an extension', () => {
  const result = deriveImageOutputPath({
    output: '/base/custom.png',
    extension: 'jpg',
    cwd: '/base',
  });
  assert.equal(result, '/base/custom.png');
});

test('deriveImageOutputPath appends the extension to an explicit output without one', () => {
  const result = deriveImageOutputPath({ output: '/base/custom', extension: 'webp', cwd: '/base' });
  assert.equal(result, '/base/custom.webp');
});

test('deriveImageOutputPath sanitizes components', () => {
  const result = deriveImageOutputPath({
    username: '../../etc',
    storyId: '9/9',
    extension: 'jpg',
    cwd: '/base',
  });
  assert.match(result, /^\/base\/etc-9_9\.jpg$/);
});

test('extensionConflicts detects a mismatch and tolerates jpg/jpeg aliases', () => {
  assert.equal(extensionConflicts('/base/a.png', 'jpeg'), true);
  assert.equal(extensionConflicts('/base/a.jpg', 'jpeg'), false);
  assert.equal(extensionConflicts('/base/a.jpeg', 'jpeg'), false);
  assert.equal(extensionConflicts('/base/a', 'jpeg'), false);
});
