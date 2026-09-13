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

## Two targets, one engine

Both targets run the same metadata code: `core/` is a plain Rust crate that
reads and writes entirely in memory. The browser build wraps it in wasm-bindgen;
the desktop build calls it directly and adds the filesystem work a browser
cannot do. There is no second implementation, so the two cannot disagree about
what "save" means — verified by writing a 100-file corpus through both paths and
diffing the results byte for byte.

The map, timeline and inspector never learn which backend they are driving.
`src/backend.js` exposes one interface with two implementations, and each
advertises what it can do so the UI hides controls that cannot work.

| | Web | Desktop |
|---|---|---|
| Engine | `img-taggr-core` (213KB gzipped as wasm) | `img-taggr-core`, linked in |
| Source | folder you pick in the browser | any folder on disk |
| Writes | new files, or a ZIP download | copies, in-place, or in-place + backups |
| JPEG · PNG · TIFF · WebP (lossless) · HEIC | yes | yes |
| Lossy WebP | no — see below | no |
| Runtime dependencies | none | none |

**HEIC is edited in place, not transcoded.** Every browser-based tool surveyed
converts HEIC to JPEG on save, handing back a re-encoded file. This one rewrites
the original container: a 3MB iPhone HEIC grows by ~132 bytes, and the image
payload is byte-identical.

**Formats are detected by content, not by filename.** Photo exports routinely
contain JPEGs named `.png`; writing those as PNG fails outright, so the magic
bytes decide and the extension is only a fallback.

**Lossy WebP cannot be written.** `little_exif` cannot convert a simple-format
VP8 chunk into the extended form that carries EXIF, so such files are rejected
rather than silently mangled. This is the one format ExifTool would handle that
this does not — see *Why not ExifTool* below.

**HEIC and TIFF have no thumbnails**, since neither the browser nor the `image`
crate can decode them; those photos show a labelled placeholder. Safari decodes
HEIC natively in the web build.

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

Nothing to install at runtime — the metadata engine is compiled in. Building
needs Rust, Node and the Tauri system libraries:

```
sudo dnf install webkit2gtk4.1-devel libsoup3-devel \
                 librsvg2-devel libappindicator-gtk3-devel
npm install
npm run dev          # development window
npm run build        # .deb / .rpm / AppImage in src-tauri/target/release/bundle
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `librsvg2-dev`.

## Why not ExifTool

ExifTool is the reference implementation and handles far more than this does.
It was the original desktop backend, and was dropped for two reasons.

It cannot go in the browser at a sensible size. ExifTool is Perl, and while Perl
*has* been compiled to WebAssembly ([zeroperl](https://github.com/6over3/zeroperl),
wrapped by [@uswriting/exiftool](https://www.npmjs.com/package/@uswriting/exiftool)),
the runtime is **7.3MB gzipped** against this engine's 213KB — 35× the size of
the entire app, for a page whose appeal is that it loads instantly.

Keeping it on the desktop only would mean two implementations of the same edit,
and they had already drifted: the ExifTool path wrote `GPSAltitude` where the
wasm path had no altitude support at all, despite a comment asserting the two
were identical.

What that costs, measured against a 100-file corpus of real photos: lossy WebP
writing, and nothing else. ExifTool extracted no usable thumbnail from any of
40 iPhone HEICs, so dropping it lost no previews either.

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
core/src/lib.rs      the metadata engine, shared by both targets (unit-tested)
src-wasm/src/lib.rs  wasm-bindgen wrapper over core — no logic of its own
src-tauri/src/
  exif.rs            desktop file I/O around core
  thumb.rs           thumbnail decode
  paths.rs           output paths + collision handling (unit-tested)
  lib.rs             Tauri commands
```

Camera RAW is deliberately excluded: rewriting a RAW container is much easier to
get wrong, and silently corrupting a negative is not an acceptable failure mode
for a metadata editor.
