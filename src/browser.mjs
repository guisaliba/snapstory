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
import { isVideoMp4 } from './media.mjs';

const INSTAGRAM_ORIGIN = 'https://www.instagram.com/';

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
 * Chromium, and reliability outranks hiding the window. The autoplay flag is
 * required so `video.play()` works without a user gesture in headed mode.
 */
export async function launchBrowser({ profileDir, headless = false, debug = false } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 800 },
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
  });
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
export async function ensureAuthenticated(context, page, { timeoutMs, log, debug }) {
  await page
    .goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});

  if (await isAuthenticated(context)) {
    log('Authenticated as existing Instagram session.');
    return;
  }

  log('No authenticated Instagram session was found.');
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
