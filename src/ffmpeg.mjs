/**
 * ffmpeg.mjs — container adapter for FFmpeg and FFprobe.
 *
 * This is a leaf module. It wraps an external process and never imports the
 * browser, capture, or media modules. The CLI (the composition root) is the
 * only caller.
 *
 * The remux uses `-c copy` only: the video and audio are already encoded, so
 * this changes the container and nothing else.
 */

import { spawn, spawnSync } from 'node:child_process';

import { AppError } from './errors.mjs';

/** Build the exact remux argument vector. */
export function buildRemuxArgs({ videoPath, audioPath = null, outputPath }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];

  if (audioPath) {
    args.push('-i', audioPath);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0');
  }

  args.push('-c', 'copy', outputPath);
  return args;
}

/**
 * Verify that FFmpeg exists. Throws a user-facing AppError when it does not.
 * @param {string} [command]
 * @returns {string} the first line of `ffmpeg -version`
 */
export function assertFfmpeg(command = 'ffmpeg') {
  let result;
  try {
    result = spawnSync(command, ['-version'], { encoding: 'utf8' });
  } catch (error) {
    throw new AppError(
      'ffmpeg-missing',
      `FFmpeg was not found (${command}).\nInstall it first, for example:\n  Arch Linux: sudo pacman -S ffmpeg\n  macOS:      brew install ffmpeg`,
      { cause: String(error) },
    );
  }
  if (result.error || result.status !== 0) {
    throw new AppError(
      'ffmpeg-missing',
      `FFmpeg was not found or is not runnable (${command}).\nInstall it first, for example:\n  Arch Linux: sudo pacman -S ffmpeg\n  macOS:      brew install ffmpeg`,
      { stderr: result.stderr, error: result.error ? String(result.error) : null },
    );
  }
  return (result.stdout || '').split('\n')[0].trim();
}

/** Return true when FFprobe is available. */
export function hasFfprobe(command = 'ffprobe') {
  try {
    const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  } catch (_error) {
    return false;
  }
}

/**
 * Run FFmpeg with the given arguments. Rejects with the captured stderr on a
 * non-zero exit so the user sees the real cause.
 */
export function runFfmpeg(args, { command = 'ffmpeg', onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) onStderr(text);
    });
    child.on('error', (error) => {
      reject(
        new AppError('ffmpeg-failed', `Failed to start FFmpeg: ${error.message}`, {
          args,
          error: String(error),
        }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stderr });
      } else {
        reject(
          new AppError('ffmpeg-failed', `FFmpeg failed with exit code ${code}.\n${stderr.trim()}`, {
            args,
            stderr,
            code,
          }),
        );
      }
    });
  });
}

/** Convenience: remux a reconstructed video (and optional audio) to one MP4. */
export async function remux({ videoPath, audioPath = null, outputPath, command = 'ffmpeg', onStderr }) {
  const args = buildRemuxArgs({ videoPath, audioPath, outputPath });
  await runFfmpeg(args, { command, onStderr });
  return args;
}

/** Run FFprobe and return the parsed JSON. */
export function probe(filePath, { command = 'ffprobe' } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      filePath,
    ];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(new AppError('invalid-output', `Failed to start FFprobe: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new AppError('invalid-output', `FFprobe failed with exit code ${code}.\n${stderr.trim()}`, {
            stderr,
          }),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new AppError('invalid-output', `Cannot parse FFprobe output: ${error.message}`, { stdout }),
        );
      }
    });
  });
}

/**
 * Validate the final file from an FFprobe result.
 *
 * @param {{ streams?: any[], format?: any }} probeResult
 * @param {{ expectAudio: boolean }} options
 * @returns {{ videoStreams: number, audioStreams: number, duration: number }}
 */
export function validateProbe(probeResult, { expectAudio }) {
  const streams = Array.isArray(probeResult?.streams) ? probeResult.streams : [];
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  if (videoStreams.length !== 1) {
    throw new AppError(
      'invalid-output',
      `Expected exactly one video stream, found ${videoStreams.length}.`,
      { streams },
    );
  }
  if (expectAudio && audioStreams.length < 1) {
    throw new AppError('invalid-output', 'Expected an audio stream, but none was found.', {
      streams,
    });
  }

  const rawDuration =
    Number.parseFloat(probeResult?.format?.duration ?? 'NaN') ||
    videoStreams
      .map((s) => Number.parseFloat(s.duration ?? 'NaN'))
      .find((value) => Number.isFinite(value)) ||
    0;

  if (!(rawDuration > 0)) {
    throw new AppError('invalid-output', 'The output duration is zero or unknown.', {
      format: probeResult?.format,
    });
  }

  return { videoStreams: videoStreams.length, audioStreams: audioStreams.length, duration: rawDuration };
}
