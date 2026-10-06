#!/usr/bin/env node
/**
 * instagram.integration.mjs — optional manual end-to-end check.
 *
 * This is NOT part of `npm test` and must never run in public CI. It needs a
 * live Instagram account, an authenticated browser profile, a currently
 * available Story URL, and FFmpeg. It downloads the Story through the real CLI
 * path and reports the exit code.
 *
 * Usage:
 *   npm run test:instagram -- 'https://www.instagram.com/stories/<user>/<id>/'
 */

import { main } from '../src/cli.mjs';

const url = process.argv[2];

if (!url) {
  process.stderr.write("Usage: npm run test:instagram -- '<story-url>'\n");
  process.exit(2);
}

const code = await main([url, '--debug']);
process.exit(code);
