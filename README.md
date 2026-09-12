# img-taggr

Edit photo **time, date and location** metadata through two linked views: a
**map** and a **day timeline**.

Runs two ways from one codebase — as a website with no server, or as a desktop
app. Photos are never uploaded in either case.

## Why

Existing tools each miss something. GeoSetter is Windows-only and unmaintained;
digiKam buries the editor inside a full photo manager; Lightroom's Map module is
subscription-only. The browser-based ones (Pic2Map, Jimpl, GeoImgr) upload your
photos to their servers. And none of them let you *drag a photo along a day* to
fix its time.

## The two views

**Map** — photos with coordinates appear as pins, joined by a dashed route in
time order.

- Click empty map to place every selected photo there.
- Drag a pin to move it. If it belongs to a multi-photo selection, the whole
  selection moves rigidly, keeping its shape.
- **Interpolate route** positions un-placed photos along the line between placed
  ones, using their timestamps. Place the first and last shot of a walk and the
  rest fall into place. Photos outside the placed time range are left alone and
  reported, never guessed at.

**Timeline** — one track per day, midnight to midnight.

- Drag a photo along its track to set its time; drag it onto another day's track
  to move it there. A guide line shows the exact landing time before you drop.
- With several photos selected, **they all shift by the same amount**, so the
  intervals between shots are preserved. This is the fix for the usual problem:
  a camera clock that was wrong for a whole trip. Hold **Alt** to move one photo
  out of formation.
- Photos with no date wait in a tray; drag one onto a day to date it, or use
  **Use file dates** to seed the whole tray from file timestamps at once.
- Overlapping shots stack into lanes rather than piling into one blob.

## Editing model

Wall-clock time and UTC offset are **separate fields**. "The clock was 3h47m
slow" and "I was in another timezone" are different repairs and must not be
conflated — shifting time never silently rewrites the offset.

Every change is staged in memory. Nothing is written until you press **Save**,
and amber dots show what is pending. Ctrl+Z walks back 50 steps.

Tags written: `DateTimeOriginal`, `CreateDate`, `ModifyDate`, `OffsetTime*`, and
`GPSLatitude`/`GPSLongitude` with their hemisphere refs.

## Two targets, one frontend

The map, timeline and inspector never learn which backend they are driving.
`src/backend.js` exposes one interface with two implementations, and each
advertises what it can do so the UI hides controls that cannot work.

| | Web | Desktop |
|---|---|---|
| Engine | `little_exif` → WASM (212KB gzipped) | `exiftool` |
| Source | folder you pick in the browser | any folder on disk |
| Writes | new files, or a ZIP download | copies, in-place, or in-place + backups |
| JPEG · PNG · TIFF · WebP (lossless) · HEIC | yes | yes |
| Lossy WebP | no — see below | yes |
| Install | none | Rust + system libs |

**HEIC is edited in place, not transcoded.** Every browser-based tool surveyed
converts HEIC to JPEG on save, handing back a re-encoded file. This one rewrites
the original container: a 3MB iPhone HEIC grows by ~132 bytes, and the image
payload is byte-identical.

**Lossy WebP is unsupported in the browser.** `little_exif` cannot convert a
simple-format VP8 chunk into the extended form that carries EXIF, so such files
are rejected rather than silently mangled. The desktop build handles them.

**Thumbnails for TIFF and HEIC are unavailable in the browser**, since Chrome
cannot decode either; those photos show a filename tile instead. Safari decodes
HEIC natively. The desktop build has thumbnails for everything.

## Running

### Web

```
npm run web          # builds the wasm, serves src/ on :8080
```

To deploy, build the wasm and publish `src/` as static files — no server-side
code, so GitHub Pages works.

Chrome and Edge can save straight back to a folder via the File System Access
API. Other browsers download a ZIP instead; the app detects this and relabels
the save dialog accordingly.

### Desktop

Needs [exiftool](https://exiftool.org/) plus the Tauri build dependencies:

```
sudo dnf install perl-Image-ExifTool webkit2gtk4.1-devel libsoup3-devel \
                 librsvg2-devel libappindicator-gtk3-devel
npm install
npm run dev          # development window
npm run build        # .deb / .rpm / AppImage in src-tauri/target/release/bundle
```

Debian/Ubuntu: `libimage-exiftool-perl`, `libwebkit2gtk-4.1-dev`,
`libsoup-3.0-dev`, `librsvg2-dev`.

### Building the wasm from scratch

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128
./build-wasm.sh
```

## Keyboard

| | |
|---|---|
| `Tab` | switch Map ⇄ Timeline |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+A` | select all |
| `Ctrl+S` | save |
| `←` `→` | shift selection 1 min (`Shift` = 10 s) |
| `Esc` | clear selection |
| click / `Shift`+click / `Ctrl`+click | select / range / toggle |

## Layout

```
src/                 frontend — plain ES modules, no build step
  backend.js         the seam: Tauri IPC or WASM, one interface
  state.js           shared state, wall-clock helpers, undo journal
  map.js             Leaflet view, drag, route interpolation
  timeline.js        day tracks, lane packing, group time shift
  app.js             filmstrip, inspector, save flow
  wasm/              generated — built by ./build-wasm.sh
src-wasm/src/lib.rs  browser metadata engine (little_exif)
src-tauri/src/
  exif.rs            exiftool wrapper: batched reads, per-file writes
  thumb.rs           embedded-preview extraction, fallback decode
  paths.rs           output paths + collision handling (unit-tested)
  lib.rs             Tauri commands
```

Camera RAW is deliberately excluded: rewriting a RAW container is much easier to
get wrong, and silently corrupting a negative is not an acceptable failure mode
for a metadata editor.
