# snapstory

Download an Instagram Story video (including its audio) or a Story photo by
capturing the media the browser receives.

## What it does

Instagram does not always expose one public MP4 URL for a Story video. The
video element often uses a Blob URL such as:

```text
blob:https://www.instagram.com/<uuid>
```

That Blob URL is not an HTTP link to the original media. Internally,
Instagram creates a `MediaSource`, creates separate `SourceBuffer` objects for
video and audio, and appends fragmented MP4 data to them.

`snapstory`:

1. Opens the Story in a real Chromium browser with your authenticated session.
2. Clicks the Instagram confirmation prompt that blocks Story media, when one
   appears.
3. Installs an interceptor **before** Instagram creates its `MediaSource`
   objects.
4. Captures every `SourceBuffer.appendBuffer()` payload.
5. Identifies the video and audio buffers by MIME type — never by buffer number.
6. Keeps every chunk in its original append order.
7. Reconstructs the fragmented MP4 video and audio streams.
8. Remuxes them into one normal `.mp4` file with FFmpeg, using stream copy.
9. Validates the result and cleans up temporary files.

When the Story is a **photo**, no MediaSource exists. `snapstory` finds the
active Story image in the page, rejects avatars and preloaded neighbors, waits
for the image to settle, fetches the signed CDN URL through the same
authenticated browser context, and saves the original bytes. Photos do not
require FFmpeg.

The video and audio are **never re-encoded**. FFmpeg only changes the container.

This tool automates the observed Instagram media behavior: MSE for videos and
signed CDN images for photos. It does not support every media format Instagram
can serve; it relies on the behavior currently observed for Story items.

## Requirements

- Node.js 20.11 or newer
- npm
- FFmpeg and FFprobe (required for video Stories; not needed for photos)
- Chromium, installed through Playwright
- An Instagram account with access to the Story

## Installation

```bash
git clone <your-repo-url> snapstory
cd snapstory
npm install
npx playwright install chromium
npm link
```

Install FFmpeg:

```bash
# Arch Linux
sudo pacman -S ffmpeg

# macOS (Homebrew)
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg
```

After `npm link`, the `snapstory` command is available everywhere.

## Usage

```bash
snapstory '<story-url>'
```

Accepted Story URL forms:

```text
https://www.instagram.com/stories/<username>/<story-id>/
https://www.instagram.com/stories/highlights/<highlight-id>/
```

Example:

```bash
snapstory \
  'https://www.instagram.com/stories/example/123456789/' \
  -o ~/Downloads/story.mp4
```

Options:

| Option | Meaning |
| --- | --- |
| `-o, --output <path>` | Output file path. Default: `<username>-<story-id>.mp4` |
| `--profile <path>` | Browser profile directory. |
| `--headless` | Run without a visible browser. Requires an authenticated profile. |
| `--keep-temp` | Keep the reconstructed video and audio files. |
| `--headed` | Force a visible browser (already the default). |
| `--timeout <seconds>` | Maximum time to wait for the Story to load and finish. |
| `--force` | Overwrite the output file if it exists. |
| `--debug` | Print detailed capture information. |
| `-h, --help` | Show usage. |

If the output file already exists and `--force` is absent, `snapstory` writes to
a unique name such as `story-1.mp4`. It never overwrites silently.

### Typical output

```text
Opening Story...
Authenticated as existing Instagram session.
Capturing media...
Video: 14 chunks, 3.8 MB
Audio: 9 chunks, 312 KB
Remuxing...
Saved: /home/user/Downloads/example-123456789.mp4
```

A Story without audio still produces a valid MP4 and prints:

```text
No audio track detected. Saved video-only Story.
```

## First login

`snapstory` does not ask for your Instagram password. It uses a persistent
browser profile. The default location is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/snapstory/profile
```

On the first run:

1. Chromium opens in headed mode at `instagram.com`.
2. If no session exists, you log in manually.
3. `snapstory` detects the new session and continues automatically.

Later runs reuse the saved session.

## Story images

When the active Story item is a photo, `snapstory` saves it as an image file.

```bash
snapstory 'https://www.instagram.com/stories/highlights/<id>/'
# Saved: /path/<username>-<story-id>.jpg
```

- Photos do not use MSE. The tool identifies the Story image in the page,
  rejects the profile avatar and preloaded neighbors, waits for the image to
  settle, then fetches the signed CDN URL through the authenticated context.
- It saves the **original bytes**. JPEG, PNG, WebP, GIF, HEIC, and AVIF are
  detected from magic bytes, not from the URL extension.
- Without `--output`, the extension comes from the detected type. With
  `--output`, the path is honored exactly, and a warning appears when its
  extension disagrees with the detected type.
- FFmpeg is not required for image Stories.
- Resolution is limited to what Instagram serves to the page. The CDN URL is
  signed; changing a size parameter is rejected with `403`.
- Only the active item is saved. Carousels are not yet supported.
- Signed URLs are treated as temporary secrets and are printed with the query
  string removed.

## Headless and remote hosts

`--headless` runs without a visible window, which is useful on a remote host
with no GUI. It requires an **existing authenticated profile**, because the
first login needs a human and a visible browser.

Seed the profile on a device with a GUI:

```bash
git clone <your-repo-url> snapstory
cd snapstory
npm install
npx playwright install chromium

# Log in once in headed mode. The session is saved when the run ends.
./bin/snapstory 'https://www.instagram.com/stories/<user>/<id>/' --keep-temp
```

The profile is written to:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/snapstory/profile
```

Copy it to the remote host over SSH:

```bash
tar -C "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" -czf snapstory-profile.tgz profile
scp snapstory-profile.tgz user@remote:/tmp/

ssh user@remote 'mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" \
  && tar -C "${XDG_DATA_HOME:-$HOME/.local/share}/snapstory" -xzf /tmp/snapstory-profile.tgz \
  && rm -f /tmp/snapstory-profile.tgz'
```

Then run headless on the remote host:

```bash
snapstory '<story-url>' --headless --debug
```

Headless mode uses Playwright's new headless mode, which is a full Chrome build.
Instagram is more likely to serve its normal player to it than to the older
headless shell. Reliability is still not guaranteed, so use `--debug` and check
the capture diagnostics.

## Security

The browser profile contains cookies and other sensitive login state. It is
stored outside the repository and is listed in `.gitignore`. Never commit or
share it. `snapstory` prints no cookies, tokens, or authorization headers, runs
fully on your machine, and includes no telemetry.

## How it works

```
  Instagram Story
        |
        v
  HTMLVideoElement  <-- blob: URL
        |
        v
  MediaSource
        |
        +---- video/mp4 SourceBuffer  (init segment + media fragments)
        +---- audio/mp4 SourceBuffer  (init segment + media fragments)
        |
        v
  exact bytes captured via Playwright bindings
        |
        +---- video fragmented MP4
        +---- audio fragmented MP4
        |
        v
  ffmpeg -c copy
        |
        v
  final Story MP4
```

The correct buffer is chosen by MIME type and by `MediaSource` identity. The
interceptor records the Blob URL that each `MediaSource` receives, so the tool
can match the currently playing `<video>` element to its `MediaSource`. This
prevents capturing a preloaded previous or next Story.

Chunks are copied at append time, given a sequence number, and sent to Node as
base64 blocks. Node writes each buffer to its own temporary file in exact
sequence order.

## Tests

```bash
npm test
```

The suite runs without Instagram and without a browser login:

- **Unit tests** — argument parsing, URL validation, MIME classification,
  buffer selection, ordered assembly, fragmented-MP4 box inspection, output
  naming, and FFmpeg command construction.
- **Remux test** — generates real fragmented media and remuxes it through the
  same FFmpeg path the CLI uses.
- **MSE fixture test** — loads a local page in headless Chromium that uses
  `MediaSource` and `SourceBuffer`, then proves the interceptor captures video
  and audio bytes byte-for-byte.
- **Image tests** — unit tests for type detection, selection, naming, and
  `srcset` parsing; browser tests for the image observer, the settle wait
  through a placeholder upgrade, and the authenticated fetch round-trip.

### Manual Instagram test

This test needs a live, authenticated session and a currently available Story.
It is not part of `npm test` and must not run in public CI.

```bash
npm run test:instagram -- 'https://www.instagram.com/stories/<user>/<id>/'
```

## Limitations

- Expired Stories cannot be downloaded.
- The logged-in account must have access to the Story.
- Instagram can change its media implementation at any time, which can break
  MSE capture or image discovery.
- Photo resolution is limited to the size Instagram serves to the page. The
  signed CDN URL cannot be edited to request a larger size.
- Carousels are not supported. Only the active Story item is saved.
- The tool depends on the MSE behavior currently observed on Instagram.
- A headed browser is used by default because headless Chromium is less
  reliable for Instagram playback and capture.

## License

MIT
