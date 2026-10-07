/**
 * browser.mjs — Playwright browser control.
 *
 * Owns the persistent Chromium context, the Instagram session, Story
 * navigation, playback, and capture-completion detection. It does not know
 * about FFmpeg or the filesystem layout.
 */

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { AppError } from './errors.mjs';
import { selectStoryImage } from './image.mjs';
import { isVideoMp4 } from './media.mjs';

const INSTAGRAM_ORIGIN = 'https://www.instagram.com/';

/**
 * How long to wait for a video element or MSE activity before classifying an
 * item as an image. Without this grace period a poster image could
 * misclassify a video Story.
 */
export const DEFAULT_VIDEO_GRACE_MS = 6000;

/**
 * Default persistent profile directory.
 * Respects XDG_DATA_HOME and works on macOS and Linux.
 */
export function defaultProfileDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'snapstory', 'profile');
}

/**
 * Launch a persistent Chromium context.
 *
 * `headless` defaults to false. Instagram behaves differently under headless
 * Chromium, and reliability outranks hiding the window.
 *
 * When `headless` is true the caller passes `channel: 'chromium'`, which
 * selects Playwright's "new" headless mode (a full Chrome build) instead of
 * the older headless shell. Instagram is more likely to serve its normal
 * player to the new headless mode.
 *
 * The autoplay flag is required so `video.play()` works without a user
 * gesture.
 */
export async function launchBrowser({ profileDir, headless = false, channel, debug = false } = {}) {
  const options = {
    headless,
    viewport: { width: 1280, height: 800 },
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  };
  if (channel) options.channel = channel;
  return chromium.launchPersistentContext(profileDir, options);
}

/** True when a `sessionid` cookie for instagram.com exists. */
export async function isAuthenticated(context) {
  const cookies = await context.cookies(INSTAGRAM_ORIGIN);
  return cookies.some((cookie) => cookie.name === 'sessionid' && cookie.value);
}

/**
 * Ensure the context has an Instagram session. On first run it opens
 * Instagram, tells the user to log in, and polls until the session cookie
 * appears, so the same run continues automatically.
 */
export async function ensureAuthenticated(context, page, { timeoutMs, log, debug, headless = false }) {
  await page
    .goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});

  if (await isAuthenticated(context)) {
    log('Authenticated as existing Instagram session.');
    return;
  }

  log('No authenticated Instagram session was found.');

  // A first login needs a human and a visible window. In headless mode there
  // is no window, so fail fast instead of waiting for a login that cannot
  // happen.
  if (headless) {
    throw new AppError(
      'auth-required',
      'No authenticated Instagram session was found.\n' +
        'Log in once in headed mode on a machine with a GUI, then copy the\n' +
        'browser profile to this host, or run without --headless.',
    );
  }

  log('A browser window was opened.');
  log('Log in to Instagram to continue.');

  const loginTimeoutMs = Math.max(timeoutMs, 300000);
  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await isAuthenticated(context)) {
      log('Login detected. Continuing.');
      return;
    }
  }

  throw new AppError(
    'auth-required',
    'Instagram authentication is required.\nRun the command in headed mode and log in.',
  );
}

/** Navigate to the Story URL. */
export async function openStory(page, storyUrl, { timeoutMs }) {
  await page.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

/**
 * Read a coarse Story state from the DOM and URL.
 *
 * This is a heuristic. Instagram has no stable public API for this, so we look
 * for the login form, known "unavailable" text, and a video element with a
 * blob source.
 */
export async function detectStoryState(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const loginForm = document.querySelector('input[name="username"], input[name="password"]');
    const url = location.href;
    const videos = Array.from(document.querySelectorAll('video'));
    const blobVideos = videos.filter((video) => (video.currentSrc || video.src || '').startsWith('blob:'));
    const images = Array.from(document.querySelectorAll('img'));
    return {
      url,
      hasLoginForm: !!loginForm || /\/accounts\/login/.test(url),
      unavailable: /sorry, this page isn't available|this page isn't available/.test(bodyText),
      expired: /story (is )?(unavailable|no longer)|this (story|content) (is )?unavailable|no longer available/.test(
        bodyText,
      ),
      privateAccount: /this account is private|private account|follow (this account|to see)/.test(bodyText),
      videoCount: videos.length,
      blobVideoCount: blobVideos.length,
      imageCount: images.length,
    };
  });
}

/**
 * Find the Story confirmation interstitial, if present.
 *
 * Instagram can show a dialog such as "View story as <username>?" with a
 * "View story" button. The media does not load until that button is clicked.
 * Matching is tolerant and case-insensitive; the label is logged in debug mode
 * so an unknown wording can be reported and added.
 */
async function findStoryGate(page) {
  const strategies = [
    page.getByRole('button', { name: /view\s+story/i }),
    page.getByRole('button', { name: /view\s+this\s+story/i }),
    page.getByRole('link', { name: /view\s+story/i }),
    page.locator('button, [role="button"], a').filter({ hasText: /view\s+story/i }),
  ];
  for (const locator of strategies) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Last-resort fallback: find the deepest visible element whose own text is
 * exactly "View story" and click it in the page. This covers prompts rendered
 * as a bare `div` without an ARIA role.
 */
async function clickGateByText(page) {
  return page
    .evaluate(() => {
      const pattern = /^\s*view\s+story\s*$/i;
      const nodes = Array.from(
        document.querySelectorAll('button, [role="button"], a, div, span'),
      );
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const element = nodes[index];
        const text = (element.innerText || element.textContent || '').trim();
        if (!pattern.test(text)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        element.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Prepare the Story for capture:
 *   1. Click the confirmation interstitial if Instagram shows one.
 *   2. Decide whether the active item is a video or an image.
 *
 * The decision order prevents a poster image from misclassifying a video:
 *   - A `<video>` element wins immediately.
 *   - Any MediaSource activity keeps the video path alive while the element
 *     mounts.
 *   - An image is accepted only after `videoGraceMs` with no video element and
 *     no MediaSource activity.
 *
 * @returns {Promise<{ ok: boolean, kind: 'video'|'image'|null, gateClicks: number, videoCount: number, imageCount: number, imageCandidates: number, buttonTexts: string[] }>}
 */
export async function prepareStory(
  page,
  { timeoutMs, videoGraceMs = DEFAULT_VIDEO_GRACE_MS, log = () => {}, debug = false },
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let gateClicks = 0;
  let buttonTexts = [];
  let imageCandidates = 0;

  while (Date.now() < deadline) {
    const gate = await findStoryGate(page);
    if (gate) {
      try {
        await gate.click({ timeout: 3000 });
        gateClicks += 1;
        if (debug) log(`[ui] Clicked the Story confirmation prompt (click ${gateClicks}).`);
        await page.waitForTimeout(1000);
        continue;
      } catch (error) {
        if (debug) log(`[ui] Could not click the Story confirmation prompt: ${error.message}`);
      }
    } else if (await clickGateByText(page)) {
      gateClicks += 1;
      if (debug) log(`[ui] Clicked the Story confirmation prompt by exact text (click ${gateClicks}).`);
      await page.waitForTimeout(1000);
      continue;
    }

    const state = await page
      .evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
          .map((element) =>
            (element.innerText || element.getAttribute('aria-label') || '').trim(),
          )
          .filter(Boolean)
          .slice(0, 25);
        const mediaSources =
          typeof window.__mseSnapshot === 'function'
            ? window.__mseSnapshot().mediaSources.length
            : 0;
        return {
          videos: document.querySelectorAll('video').length,
          images: document.querySelectorAll('img').length,
          mediaSources,
          buttons,
        };
      })
      .catch(() => ({ videos: 0, images: 0, mediaSources: 0, buttons: [] }));

    buttonTexts = state.buttons;

    if (state.videos > 0) {
      return {
        ok: true,
        kind: 'video',
        gateClicks,
        videoCount: state.videos,
        imageCount: state.images,
        imageCandidates,
        buttonTexts,
      };
    }

    if (state.mediaSources === 0 && state.images > 0) {
      const candidates = await page
        .evaluate(() =>
          typeof window.__snapstorySnapshotImages === 'function'
            ? window.__snapstorySnapshotImages()
            : [],
        )
        .catch(() => []);
      imageCandidates = candidates.length;
      const selection = selectStoryImage(candidates);
      if (selection.chosen && Date.now() - startedAt >= videoGraceMs) {
        if (debug) {
          log(
            `[ui] Classified Story as image after ${Date.now() - startedAt}ms (tier ${selection.tier}).`,
          );
        }
        return {
          ok: true,
          kind: 'image',
          gateClicks,
          videoCount: 0,
          imageCount: state.images,
          imageCandidates,
          buttonTexts,
        };
      }
    }

    await page.waitForTimeout(500);
  }

  const finalState = await page
    .evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      images: document.querySelectorAll('img').length,
    }))
    .catch(() => ({ videos: 0, images: 0 }));

  if (debug) log(`[ui] Visible buttons at timeout: ${JSON.stringify(buttonTexts)}`);
  return {
    ok: false,
    kind: null,
    gateClicks,
    videoCount: finalState.videos,
    imageCount: finalState.images,
    imageCandidates,
    buttonTexts,
  };
}

/**
 * Start playback of the most likely Story video and unmute it.
 *
 * Playback matters: Instagram fetches and appends media fragments while the
 * video plays. Unmuting does not change MSE capture, but it matches the tested
 * manual process.
 */
export async function startPlayback(page) {
  return page.evaluate(async () => {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return { ok: false, reason: 'no-video-element' };

    const scored = videos
      .map((video) => {
        let visible = false;
        try {
          const rect = video.getBoundingClientRect();
          visible = rect.width > 8 && rect.height > 8;
        } catch (_error) {
          visible = false;
        }
        let score = 0;
        if (visible) score += 2;
        if (video.currentSrc || video.src) score += 1;
        if (video.readyState >= 2) score += 1;
        return { video, score };
      })
      .sort((a, b) => b.score - a.score);

    const video = scored[0]?.video;
    try {
      video.muted = false;
    } catch (_error) {
      /* ignore */
    }
    try {
      await video.play();
      return { ok: true };
    } catch (error) {
      try {
        video.muted = true;
        await video.play();
        return { ok: true, muted: true };
      } catch (error2) {
        return { ok: false, reason: 'play-failed', message: String(error2) };
      }
    }
  });
}

/**
 * Wait until the active video is associated with a MediaSource that already
 * has video/mp4 data. Returns the locked MediaSource id and its video buffer.
 *
 * Locking the MediaSource early is what prevents capturing a preloaded
 * neighbor Story.
 */
export async function waitForActiveMediaSource(page, { timeoutMs, log, debug }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() =>
      typeof window.__mseSnapshot === 'function' ? window.__mseSnapshot() : null,
    );
    if (snapshot && snapshot.activeMediaSourceId !== null && snapshot.activeMediaSourceId !== undefined) {
      const mediaSource = snapshot.mediaSources.find((ms) => ms.id === snapshot.activeMediaSourceId);
      const videoBuffer = mediaSource?.buffers?.find((b) => isVideoMp4(b.mime));
      if (videoBuffer && videoBuffer.chunkCount > 0) {
        const activeVideo = snapshot.videos.find((v) => v.mediaSourceId === snapshot.activeMediaSourceId);
        if (debug) {
          log(
            `[capture] Active MediaSource ${snapshot.activeMediaSourceId} (video buffer ${videoBuffer.id}, ${videoBuffer.chunkCount} chunks)`,
          );
        }
        return {
          mediaSourceId: snapshot.activeMediaSourceId,
          videoBuffer,
          duration: activeVideo?.duration ?? null,
        };
      }
    }
    await page.waitForTimeout(500);
  }

  throw new AppError(
    'no-video-buffer',
    'No video media was captured for this Story.\nThe Story may not have started playing.',
  );
}

/**
 * Wait until capture for the locked MediaSource is complete.
 *
 * Completion requires several signals at once, so a final append is never cut
 * off:
 *   1. Every buffer has `updating === false`.
 *   2. The video buffer is buffered to the end, or playback ended.
 *   3. No append has arrived for a quiet period.
 * The condition must hold for two consecutive polls.
 */
export async function waitForCaptureComplete(
  page,
  mediaSourceId,
  { timeoutMs, log, debug, quietMs = 1500, pollMs = 500 },
) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;

  while (Date.now() < deadline) {
    const status = await page.evaluate(
      ({ id }) => {
        const snapshot =
          typeof window.__mseSnapshot === 'function' ? window.__mseSnapshot() : null;
        if (!snapshot) return null;
        const mediaSource = snapshot.mediaSources.find((ms) => ms.id === id);
        if (!mediaSource) return null;
        const video = mediaSource.buffers.find((b) => (b.mime || '').startsWith('video/mp4'));
        const activeVideo = snapshot.videos.find((v) => v.mediaSourceId === id);
        const allBuffers = mediaSource.buffers;
        const anyUpdating = allBuffers.some((b) => b.updating);
        const now = Date.now();
        const lastAppendAt = allBuffers.reduce((max, b) => Math.max(max, b.lastAppendAt || 0), 0);
        const quietFor = lastAppendAt === 0 ? 0 : now - lastAppendAt;
        const duration = activeVideo?.duration ?? null;
        const bufferedEnd = video?.bufferedEnd ?? null;
        const reachedEnd =
          (duration && bufferedEnd !== null && bufferedEnd >= duration - 1) ||
          (duration && activeVideo && activeVideo.currentTime >= duration - 0.25) ||
          !!activeVideo?.ended;
        return {
          anyUpdating,
          quietFor,
          reachedEnd,
          duration,
          bufferedEnd,
          videoChunks: video?.chunkCount ?? 0,
          audioChunks: mediaSource.buffers
            .filter((b) => (b.mime || '').startsWith('audio/mp4'))
            .reduce((sum, b) => sum + b.chunkCount, 0),
        };
      },
      { id: mediaSourceId },
    );

    if (status) {
      const durationKnown = status.duration !== null && status.duration !== undefined && status.duration > 0;
      // When the buffered end is reached we accept a short quiet period. When
      // the duration never becomes known, the quiet period alone decides.
      const quietTarget = status.reachedEnd ? quietMs : Math.max(quietMs, 4000);
      const complete =
        !status.anyUpdating &&
        status.videoChunks > 0 &&
        status.quietFor >= quietTarget &&
        (status.reachedEnd || !durationKnown);
      if (debug) {
        log(
          `[capture] waiting: updating=${status.anyUpdating} reachedEnd=${status.reachedEnd} quiet=${Math.round(
            status.quietFor,
          )}ms video=${status.videoChunks} audio=${status.audioChunks}`,
        );
      }
      if (complete) {
        consecutive += 1;
        if (consecutive >= 2) return status;
      } else {
        consecutive = 0;
      }
    }

    await page.waitForTimeout(pollMs);
  }

  throw new AppError(
    'timeout',
    'Timed out while waiting for the Story media to finish buffering.',
  );
}
