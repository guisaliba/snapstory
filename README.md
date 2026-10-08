# snapstory

Download an Instagram Story **video (with audio)** or a Story **photo** from a
real, authenticated browser session.

Instagram rarely exposes a direct MP4 or image URL. Videos play through Media
Source Extensions (MSE), with separate video and audio `SourceBuffer` objects.
Photos are served as signed CDN images. `snapstory` opens the Story in a real
Chromium session, captures what the browser receives, and saves a normal file.
Media is never re-encoded: FFmpeg only remuxes the container for videos, and
photos need no FFmpeg at all.

**Scope:** one Story item per run. An id-less URL captures the currently
displayed item. Carousels are not supported.

## Quick start

```bash
git clone https://github.com/guisaliba/snapstory.git
cd snapstory
npm install
npx playwright install chromium
npm link

# First login once, with a visible window:
snapstory 'https://www.instagram.com/stories/example/123456789/' --headed

# Later runs are headless:
snapstory 'https://www.instagram.com/stories/example/123456789/'
```

`npm link` is **not required**. It only puts the `snapstory` command on your
`PATH`. Without it, run `./bin/snapstory` in place of `snapstory`; every flag and
behavior is identical. Video Stories also need FFmpeg on `PATH`; photos do not.

## Requirements

- Node.js 20.11 or newer and npm
- Chromium, installed through Playwright
- FFmpeg and FFprobe (video Stories only)
- An Instagram account with access to the Story

## Installation

```bash
git clone https://github.com/guisaliba/snapstory.git
cd snapstory
npm install
npx playwright install chromium
```

Install FFmpeg:

```bash
# Arch Linux
sudo pacman -S ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# macOS (Homebrew)
brew install ffmpeg
```

### The global command

`npm link` creates a global symlink to this checkout, useful while developing.
For a standalone global copy, use `npm install -g .`. Remove either with
`npm unlink -g snapstory` or `npm uninstall -g snapstory`.

Publishing to a registry would remove the clone step entirely
(`npm install -g snapstory`, `npx snapstory`), but requires a publish and is not
needed to use the tool.

## Usage

```bash
snapstory '<story-url>' [options]
```

From the checkout, use `./bin/snapstory` instead of the bare command.

Accepted Story URL forms:

```text
https://www.instagram.com/stories/<username>/<story-id>/
https://www.instagram.com/stories/<username>/
https://www.instagram.com/stories/highlights/<highlight-id>/
```

Instagram sometimes keeps the address bar at `/stories/<username>/` with no
story id, even while a live Story is displayed. Both forms are accepted. With no
id, the currently displayed item is captured.

Example:

```bash
snapstory \
  'https://www.instagram.com/stories/example/123456789/' \
  -o ~/Downloads/story.mp4
```

| Option | Meaning |
| --- | --- |
| `-o, --output <path>` | Output file path. Defaults below. |
| `--profile <path>` | Browser profile directory. Default: `${XDG_DATA_HOME:-$HOME/.local/share}/snapstory/profile`. |
| `--headless` | Run without a visible browser. Default. Requires an authenticated profile. |
| `--headed` | Show the browser window. Use it for the first login. |
| `--keep-temp` | Keep reconstructed temporary files. `--debug` also keeps them. |
| `--timeout <seconds>` | Maximum wait for the Story to load and finish. Default 120. |
| `--device-scale-factor <n>` | Browser device pixel ratio. Default 2. Higher values can make Instagram serve larger photos. |
| `--force` | Overwrite the output file if it exists. |
| `--debug` | Print detailed capture information. |
| `-h, --help` | Show usage. |

Default file names:

- `<username>-<story-id>.<ext>` when both parts are known
- `<username>.<ext>` when the URL has no story id
- `story.<ext>` when neither is known
- If the file exists and `--force` is absent, a `-1`, `-2`, ... suffix is added.
  `snapstory` never overwrites silently.

## What to expect

A video Story with audio:

```text
Opening Story...
Authenticated as existing Instagram session.
Capturing media...
Video: 14 chunks, 3.8 MB
Audio: 9 chunks, 312 KB
Remuxing...
Saved: /home/user/example-123456789.mp4
```

A video Story without audio still produces a valid MP4 and adds:

```text
No audio track detected. Saved video-only Story.
```

A photo Story:

```text
Opening Story...
Authenticated as existing Instagram session.
Capturing media...
Capturing image...
Photo: jpeg 35 KB (https://instagram.fmcz2-1.fna.fbcdn.net/v/t51.../photo.jpg)
Saved: /home/user/example-123456789.jpg
```

Success markers to confirm the tool worked: a `Video:`/`Audio:` or `Photo:` line
with non-zero counts or bytes, `Remuxing...` for videos, and a `Saved:` line
whose file opens normally.

## First login

`snapstory` runs **headless by default** and never asks for your Instagram
password. It uses a persistent browser profile:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/snapstory/profile
```

The first login needs a visible window, so run once with `--headed`:

```bash
snapstory '<story-url>' --headed
```

If no session exists, Chromium opens, you log in manually, and the same run
continues. Later runs reuse the session headless. A headless run with no session
exits with code 3 and prints the profile path and the exact `--headed` command.
Use the same `--profile` path for the login run and all later runs.

## Photos

- Photos do not use MSE. The tool identifies the active Story image, rejects the
  profile avatar and preloaded neighbors, waits for the image to settle, then
  fetches the signed CDN URL through the authenticated context.
- It saves the **original bytes**. JPEG, PNG, WebP, GIF, HEIC, and AVIF are
  detected from magic bytes, not from the URL.
- With `--output`, the path is honored exactly, and a warning appears if its
  extension disagrees with the detected type. Without `--output`, the extension
  comes from the detected type.
- FFmpeg is not required for photos.
- Resolution is limited to what Instagram serves to the page. The signed URL
  cannot be edited; changing a size parameter returns `403`. The default device
  pixel ratio of 2 makes Instagram serve a larger variant: live testing measured
  480×853 at ratio 1 and 1179×2096 at ratio 2 on the same Story. Ratio 3 gave the
  same variant as 2. Use `--device-scale-factor 1` for the old behavior.
- Only the active item is saved.
- Signed image URLs are temporary secrets. Logs print them without the query
  string.

## Remote and headless hosts

Headless is the default, which makes the tool usable on a host with no GUI. It
requires an **existing authenticated profile**, because the first login needs a
human and a visible browser.

Seed the profile on a device with a GUI:

```bash
git clone https://github.com/guisaliba/snapstory.git
cd snapstory
npm install
npx playwright install chromium

# Log in once with a visible window. The session is saved when the run ends.
./bin/snapstory 'https://www.instagram.com/stories/<user>/<id>/' --headed --keep-temp
```

Copy the profile to the remote host over SSH:

```bash
tar -C "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" -czf snapstory-profile.tgz profile
scp snapstory-profile.tgz user@remote:/tmp/

ssh user@remote 'mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" \
  && tar -C "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" -xzf /tmp/snapstory-profile.tgz \
  && rm -f /tmp/snapstory-profile.tgz'
```

Then run on the remote host:

```bash
snapstory '<story-url>' --debug
```

Headless mode uses Playwright's new headless mode, a full Chrome build.
Reliability is not guaranteed because Instagram can change its behavior, so use
`--debug` and check the capture lines. When authentication fails, the error
names the resolved profile directory, and `--debug` lists the visible
`instagram.com` cookie names (names only, never values).

## Troubleshooting

Confirm the environment before a run:

```bash
./bin/snapstory --help
npx playwright install chromium     # once
ffmpeg -version && ffprobe -version # video Stories
```

Exit codes and what to do:

| Exit | Message starts with | Meaning and action |
| --- | --- | --- |
| 2 | `Only instagram.com Story URLs...` or `Expected a URL like...` | Invalid URL. Use one of the accepted forms. |
| 2 | `FFmpeg was not found...` | Install FFmpeg, or download a photo Story. |
| 3 | `No authenticated Instagram session was found in: <profile>` | Run once with `--headed` and the same `--profile`. |
| 4 | `The Story is unavailable or has expired.` | The Story is gone. It cannot be downloaded. |
| 5 | `The current Instagram account cannot access this Story.` | Use an account that can see the Story. |
| 6 | `The selected Story does not contain a video or an image.` | Retry. If it repeats, run `--debug` and report the printed button labels. |
| 7 | `No video media was captured...`, `Capture started after...`, `The video SourceBuffer captured zero bytes`, `Several MediaSource...` | Capture failed or was incomplete. Retry with `--debug` and report the diagnostics. |
| 7 | `Could not download the Story image (HTTP 403).` | The signed URL was rejected or expired. Retry. |
| 8 | `FFmpeg failed...` | Remux failed. FFmpeg stderr is printed. Run with `--debug` to keep the reconstructed files and report them. |
| 8 | `Expected exactly one video stream...` or a zero duration | The output failed validation. Report with `--debug`. |
| 9 | `Timed out while waiting...` | The Story was slow or blocked. Retry, raise `--timeout`, or report with `--debug`. |
| 130 | `Received SIGINT` | Interrupted. Temporary files are cleaned. |

If behavior looks wrong:

1. Re-run with `--debug`. It prints the browser mode, the profile directory, the
   cookie names, candidate media, buffer choices, and the FFmpeg command, and it
   keeps the temporary files. Temporary paths are printed at the end.
2. Check the success markers above. A run that does not print `Saved:` failed.
3. Open an issue at https://github.com/guisaliba/snapstory/issues with the
   command, the `--debug` output, and what you expected. Logs strip signed query
   strings, so the output is safe to paste.
4. Never attach the browser profile, cookies, or a downloaded Story.

## Security

The browser profile contains cookies and other sensitive login state. It lives
outside the repository and is listed in `.gitignore`. Never commit or share it.
`snapstory` prints no cookies, tokens, or authorization headers, runs fully on
your machine, and includes no telemetry. Downloaded Stories stay local.

## Tests

```bash
npm test
```

The suite needs no Instagram account:

- Unit tests: argument parsing, URL validation, MIME classification, buffer
  selection, ordered assembly, fragmented-MP4 inspection, image detection,
  naming, and FFmpeg argument construction.
- Remux test: generates fragmented media and remuxes it through the same FFmpeg
  path the CLI uses.
- MSE fixture test: proves the interceptor captures video and audio bytes
  byte-for-byte in headless Chromium.
- Image tests: observer, selection, placeholder upgrade through the settle wait,
  and the authenticated fetch round-trip.
- Auth tests: headless fail-fast names the profile, and cookie values never
  reach the log.

Manual live check (needs an authenticated profile):

```bash
npm run test:instagram -- 'https://www.instagram.com/stories/<user>/<id>/'
```

## Limitations

- Expired Stories cannot be downloaded.
- The logged-in account must have access to the Story.
- Instagram can change its media implementation at any time.
- Photo resolution is bounded by what Instagram serves to the page.
- Carousels are not supported. Only the active item is saved.
- The first login needs a visible window, so one `--headed` run is required.

## How it works

```
  Story item
      |
      +-- video: MediaSource -> video/mp4 + audio/mp4 SourceBuffers
      |          -> exact appendBuffer bytes, in order
      |          -> two fragmented MP4 files -> ffmpeg -c copy
      |
      +-- photo: <img> with a signed CDN URL
                 -> fetched through the authenticated context
                 -> original bytes saved unchanged

  Output: one normal .mp4 (video + audio) or one image file
```

The video buffer is chosen by MIME type and `MediaSource` identity, never by
buffer number, so preloaded Stories are not mistaken for the active one. Chunks
are copied at append time, sequenced, and written to disk in exact order. For
photos, the active image is identified with the `efg` media tag and geometry,
then locked and settled before the fetch.

## License

MIT
