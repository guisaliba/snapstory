#!/usr/bin/env node
/**
 * cli.mjs — the composition root.
 *
 * Owns argument parsing, URL validation, policy, the process lifecycle, and
 * error-to-exit-code mapping. It wires the browser, capture, media, and FFmpeg
 * modules together. No other module orchestrates.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

import { AppError, EXIT_CODES, exitCodeFor } from './errors.mjs';
import { INIT_SCRIPT, CaptureReceiver, collectSnapshot, waitForPendingDrain } from './capture.mjs';
import {
  deriveOutputPath,
  expandHome,
  formatBytes,
  inspectInitSegment,
  nextAvailablePath,
  selectBuffers,
} from './media.mjs';
import {
  assertFfmpeg,
  buildRemuxArgs,
  hasFfprobe,
  probe,
  remux,
  validateProbe,
} from './ffmpeg.mjs';
import {
  defaultProfileDir,
  detectStoryState,
  ensureAuthenticated,
  launchBrowser,
  openStory,
  startPlayback,
  waitForActiveMediaSource,
  waitForCaptureComplete,
} from './browser.mjs';

const STORY_URL = /^https?:\/\/(?:www\.)?instagram\.com\/stories\/([^/?#]+)\/(\d+)\/?(?:[?#].*)?$/i;

/**
 * Validate a Story URL and extract its parts.
 * @param {string} raw
 * @returns {{ url: string, username: string, storyId: string }}
 */
export function validateStoryUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('invalid-url', 'Missing Story URL.');
  }
  const trimmed = raw.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    throw new AppError('invalid-url', `Not a valid URL: ${trimmed}`);
  }
  if (!/^(www\.)?instagram\.com$/i.test(parsed.hostname)) {
    throw new AppError('invalid-url', 'Only instagram.com Story URLs are allowed.');
  }
  const match = STORY_URL.exec(trimmed);
  if (!match) {
    throw new AppError(
      'invalid-url',
      'Expected a URL like https://www.instagram.com/stories/<username>/<story-id>/',
    );
  }
  return {
    url: `https://www.instagram.com/stories/${match[1]}/${match[2]}/`,
    username: match[1],
    storyId: match[2],
  };
}

/**
 * Parse CLI arguments.
 * @param {string[]} argv arguments without the node and script paths
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        profile: { type: 'string' },
        'keep-temp': { type: 'boolean' },
        headed: { type: 'boolean' },
        timeout: { type: 'string' },
        debug: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new AppError('bad-usage', error.message);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    return {
      help: true,
      url: null,
      output: null,
      profile: null,
      keepTemp: false,
      headed: false,
      timeoutMs: 120000,
      debug: false,
      force: false,
    };
  }

  if (positionals.length === 0) throw new AppError('bad-usage', 'Missing Story URL.');
  if (positionals.length > 1) throw new AppError('bad-usage', 'Expected exactly one Story URL.');

  let timeoutMs = 120000;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new AppError('bad-usage', '--timeout must be a positive number of seconds.');
    }
    timeoutMs = Math.round(seconds * 1000);
  }

  return {
    help: false,
    url: positionals[0],
    output: values.output ?? null,
    profile: values.profile ?? null,
    keepTemp: !!values['keep-temp'],
    headed: !!values.headed,
    timeoutMs,
    debug: !!values.debug,
    force: !!values.force,
  };
}

export function usage() {
  return `snapstory — download an Instagram Story video (with audio) via MSE capture

Usage:
  snapstory '<story-url>' [options]

Options:
  -o, --output <path>   Output file path. Default: <username>-<story-id>.mp4
      --profile <path>  Browser profile directory.
      --keep-temp       Keep reconstructed video and audio files.
      --headed          Force a visible browser (already the default).
      --timeout <sec>   Maximum time to wait for the Story to load and finish.
      --force           Overwrite the output file if it exists.
      --debug           Print detailed capture information.
  -h, --help            Show this help.

Example:
  snapstory 'https://www.instagram.com/stories/example/123456789/' -o ~/Downloads/story.mp4
`;
}

/** Read the head of a file for box inspection. */
async function readFileHead(file, maxBytes = 8 * 1024 * 1024) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Wait until incoming chunk totals stop changing, so no late IPC is cut off. */
async function stabilizeReceiver(receiver, { quietMs = 300, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastTotal = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const snapshot = receiver.snapshot();
    const total = snapshot.buffers.reduce((sum, entry) => sum + entry.byteCount, 0);
    if (total === lastTotal) {
      if (Date.now() - stableSince >= quietMs) return;
    } else {
      lastTotal = total;
      stableSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Run the command.
 * @param {string[]} argv
 * @param {{ out?: NodeJS.WriteStream, err?: NodeJS.WriteStream }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  const log = (message) => out.write(`${message}\n`);

  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (error) {
    err.write(`${error.message}\n\n`);
    err.write(usage());
    return EXIT_CODES.usage;
  }

  if (opts.help) {
    out.write(usage());
    return EXIT_CODES.ok;
  }

  const debug = opts.debug;
  const dlog = debug ? (message) => out.write(`${message}\n`) : () => {};

  let story;
  try {
    story = validateStoryUrl(opts.url);
  } catch (error) {
    err.write(`${error.message}\n`);
    return exitCodeFor(error);
  }

  try {
    dlog(`FFmpeg: ${assertFfmpeg()}`);
  } catch (error) {
    err.write(`${error.message}\n`);
    return exitCodeFor(error);
  }

  const requestedOutput = deriveOutputPath({
    output: opts.output,
    username: story.username,
    storyId: story.storyId,
  });
  const outputPath = opts.force ? requestedOutput : nextAvailablePath(requestedOutput);
  if (outputPath !== requestedOutput) {
    log(`Output exists; writing to ${outputPath}`);
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snapstory-'));
  dlog(`Working directory: ${workDir}`);

  const profileDir = opts.profile
    ? path.resolve(expandHome(opts.profile))
    : defaultProfileDir();
  await fs.promises.mkdir(profileDir, { recursive: true });
  dlog(`Profile directory: ${profileDir}`);

  const receiver = new CaptureReceiver({ workDir, debug, log: dlog });
  let context = null;
  let keepTemp = opts.keepTemp || debug;
  let interrupted = false;

  const onSignal = async (signal) => {
    if (interrupted) return;
    interrupted = true;
    err.write(`\nReceived ${signal}. Closing browser...\n`);
    try {
      if (context) await context.close();
    } catch (_error) {
      /* ignore */
    }
    if (!keepTemp) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    process.exit(EXIT_CODES.interrupted);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    log('Opening Story...');

    context = await launchBrowser({ profileDir, headless: false, debug });
    await receiver.attach(context);
    await context.addInitScript({ content: INIT_SCRIPT });

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(opts.timeoutMs);

    await ensureAuthenticated(context, page, {
      timeoutMs: opts.timeoutMs,
      log,
      debug,
    });

    await openStory(page, story.url, { timeoutMs: opts.timeoutMs });

    const state = await detectStoryState(page);
    dlog(`Story state: ${JSON.stringify(state)}`);
    if (state.hasLoginForm) {
      throw new AppError(
        'auth-required',
        'Instagram authentication is required.\nRun the command in headed mode and log in.',
      );
    }
    if (state.expired || state.unavailable) {
      throw new AppError('story-unavailable', 'The Story is unavailable or has expired.');
    }
    if (state.privateAccount) {
      throw new AppError(
        'story-private',
        'The current Instagram account cannot access this Story.',
      );
    }

    log('Capturing media...');
    const play = await startPlayback(page);
    if (!play.ok && play.reason === 'no-video-element') {
      throw new AppError('no-video', 'The selected Story does not contain a video.');
    }
    if (!play.ok) {
      throw new AppError(
        'capture-failed',
        `Could not start Story playback: ${play.reason}${play.message ? ` (${play.message})` : ''}`,
      );
    }

    const active = await waitForActiveMediaSource(page, {
      timeoutMs: opts.timeoutMs,
      log,
      debug,
    });
    dlog(`Locked MediaSource ${active.mediaSourceId}`);

    await waitForCaptureComplete(page, active.mediaSourceId, {
      timeoutMs: opts.timeoutMs,
      log,
      debug,
    });
    await waitForPendingDrain(page, { timeoutMs: 15000 });
    await page.waitForTimeout(300);
    await stabilizeReceiver(receiver);
    await receiver.finalize();

    const snapshot = await collectSnapshot(page, receiver);
    const selection = selectBuffers(snapshot, { debug });
    if (!selection.video.path) {
      throw new AppError('capture-failed', 'The video buffer has no temporary file.');
    }
    if (selection.audio && !selection.audio.path) {
      throw new AppError('capture-failed', 'The audio buffer has no temporary file.');
    }

    inspectInitSegment(await readFileHead(selection.video.path), { label: 'video' });
    if (selection.audio) {
      inspectInitSegment(await readFileHead(selection.audio.path), { label: 'audio' });
    }

    log(`Video: ${selection.video.chunkCount} chunks, ${formatBytes(selection.video.byteCount)}`);
    if (selection.audio) {
      log(`Audio: ${selection.audio.chunkCount} chunks, ${formatBytes(selection.audio.byteCount)}`);
    } else {
      log('No audio track detected. Saved video-only Story.');
    }

    log('Remuxing...');
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const command = buildRemuxArgs({
      videoPath: selection.video.path,
      audioPath: selection.audio?.path ?? null,
      outputPath,
    });
    dlog(`FFmpeg command: ffmpeg ${command.join(' ')}`);
    await remux({
      videoPath: selection.video.path,
      audioPath: selection.audio?.path ?? null,
      outputPath,
      onStderr: debug ? (text) => out.write(text) : undefined,
    });

    if (hasFfprobe()) {
      const probeResult = await probe(outputPath);
      const summary = validateProbe(probeResult, { expectAudio: !!selection.audio });
      dlog(
        `Output: ${summary.videoStreams} video stream(s), ${summary.audioStreams} audio stream(s), ${summary.duration.toFixed(2)}s`,
      );
    } else {
      const stat = await fs.promises.stat(outputPath);
      if (!(stat.size > 0)) throw new AppError('invalid-output', 'The output file is empty.');
    }

    log(`Saved: ${outputPath}`);
    keepTemp = opts.keepTemp || debug;
    return EXIT_CODES.ok;
  } catch (error) {
    if (debug && error?.details) dlog(`[error] ${JSON.stringify(error.details)}`);
    if (error instanceof AppError) {
      err.write(`${error.message}\n`);
      return exitCodeFor(error);
    }
    err.write(`Unexpected error: ${error?.stack ?? String(error)}\n`);
    return EXIT_CODES.generic;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (context) {
      try {
        await context.close();
      } catch (_error) {
        /* ignore */
      }
    }
    if (!keepTemp) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    } else {
      dlog(`Temporary files kept in ${workDir}`);
    }
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`Fatal: ${error?.stack ?? String(error)}\n`);
      process.exit(EXIT_CODES.generic);
    });
}
