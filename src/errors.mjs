/**
 * Shared error type and exit-code mapping for snapstory.
 *
 * Every failure that the user should act on is an AppError with a stable
 * `code`. The CLI maps the code to a non-zero process exit code and prints the
 * message. Keeping the mapping in one place makes the contract explicit and
 * testable.
 */

export class AppError extends Error {
  /**
   * @param {string} code stable machine-readable identifier
   * @param {string} message human-readable message, safe to print
   * @param {Record<string, unknown>} [details] debug-only context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const EXIT_CODES = Object.freeze({
  ok: 0,
  generic: 1,
  usage: 2,
  ffmpegMissing: 2,
  authRequired: 3,
  storyUnavailable: 4,
  storyPrivate: 5,
  noVideo: 6,
  captureFailed: 7,
  ffmpegFailed: 8,
  invalidOutput: 8,
  timeout: 9,
  interrupted: 130,
});

const CODE_TO_EXIT = Object.freeze({
  'invalid-url': EXIT_CODES.usage,
  'bad-usage': EXIT_CODES.usage,
  'ffmpeg-missing': EXIT_CODES.ffmpegMissing,
  'auth-required': EXIT_CODES.authRequired,
  'story-unavailable': EXIT_CODES.storyUnavailable,
  'story-private': EXIT_CODES.storyPrivate,
  'no-video': EXIT_CODES.noVideo,
  'no-video-buffer': EXIT_CODES.captureFailed,
  'empty-capture': EXIT_CODES.captureFailed,
  'capture-started-late': EXIT_CODES.captureFailed,
  'ambiguous-buffer': EXIT_CODES.captureFailed,
  'ffmpeg-failed': EXIT_CODES.ffmpegFailed,
  'invalid-output': EXIT_CODES.invalidOutput,
  timeout: EXIT_CODES.timeout,
});

/**
 * Map an error to a process exit code.
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeFor(error) {
  if (error instanceof AppError) {
    return CODE_TO_EXIT[error.code] ?? EXIT_CODES.generic;
  }
  return EXIT_CODES.generic;
}
