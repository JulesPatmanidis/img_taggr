# img-taggr

Edit photo **time, date and location** metadata through a **map** and a **timeline** view.

Runs two ways from one codebase, as a website with no server or as a desktop
app.

<img src="imgs/placed.png" width="820" alt="img-taggr with photos placed on the map and dated on the timeline">

## Features 

**Map.** Photos with coordinates appear as pins, joined by a dashed route in
time order. Nearby pins merge into a numbered cluster, and photos sitting on
the very same spot fan out when you click them.

- Search for a place to fly there. Search only moves the map.
- Click the map to place every selected photo there (the cursor turns into a
  crosshair while a click would do that), or drop photos from the list.
- Drag a pin to move it. If it belongs to a multi-photo selection, the whole
  selection moves rigidly, keeping its shape.
- Switch between the street map and satellite imagery.
- **Interpolate route** positions un-placed photos along the line between placed
  ones, using their timestamps. Place the first and last shot of a walk and the
  rest fall into place. Photos outside the placed time range are left alone and
  reported, never guessed at.

**Timeline.** One continuous track across the whole set, with day boundaries
marked. Scroll to pan, Ctrl+scroll (or pinch) to zoom, **Fit all** to see
everything.

- Drag a photo to set its time.
- With several photos selected **they all shift by the same amount**, so the
  intervals between shots stay as they were. Hold **Alt** to move one photo out of
  formation.
- Drag across empty track to select the photos inside a box.
- Drop undated photos from the list to date them. 
- **Distribute evenly** spaces the selected photos at equal intervals between
  the first and the last, which untangles a burst dropped on one spot.
- Shots that would overlap step down one row each, earliest on top.

A folder of scans opens with nothing dated and nothing placed. **Date this
batch** takes a start time and one interval and dates the whole roll in filename
order, which is the order it was shot in.

<img src="imgs/first-run.png" width="820" alt="A freshly opened folder, nothing dated or placed yet">

## Editing model

Wall-clock time and UTC offset are **separate fields**.

The inspector on the right edits the selection in place. Date and time are one
`YYYY-MM-DD HH:MM:SS` field. On a mixed selection, changing only the date leaves
each photo its own time. **Shift by** takes `+3h47m`, `-15s` or `-0:15` and moves 
every selected photo.

The app stages every change in memory and writes nothing until you press
**Save**. Amber dots show what is still pending.

Tags written: `DateTimeOriginal`, `CreateDate`, `ModifyDate`, `OffsetTime*`, and
`GPSLatitude`/`GPSLongitude` with their hemisphere refs.

## Architecture

Both targets (desktop and web) run the same metadata code: `engine/` is a plain Rust crate that
reads and writes in memory. The browser build wraps it in wasm-bindgen, and the
desktop build calls it directly.

The map, timeline and inspector never learn which backend they are driving.
`app/backend.js` exposes one interface with two implementations, and each
advertises what it can do so the UI hides controls that cannot work.

| | Web | Desktop |
|---|---|---|
| Engine | `img-taggr-core` | `img-taggr-core` |
| Source | folder you pick in the browser | any folder on disk |
| Writes | new files, or a ZIP download | copies, in-place, or in-place + backups |
| JPEG · PNG · TIFF · WebP (lossless) · HEIC | yes | yes |

## Limitations 
- Lossy WebP and RAW formats are not supported.
- HEIC and TIFF have no thumbnails, since neither the browser nor the `image`
crate can decode them. Safari decodes HEIC on its own in the web build.

## Running

### Web

```
npm run web          # builds the wasm, serves app/ on http://localhost:8080
```

To deploy, build the wasm and publish `app/` as static files.

Open a folder with the button or by dropping it onto the window. Chrome and Edge
can save straight back to a folder via the File System Access API. Other
browsers download a ZIP instead.

### Desktop

Nothing to install at runtime, since the metadata engine is compiled in.
Building needs Rust, Node and the Tauri system libraries:

```
sudo dnf install webkit2gtk4.1-devel libsoup3-devel \
                 librsvg2-devel libappindicator-gtk3-devel
npm install
npm run dev          # development window
npm run build        # .deb / .rpm / AppImage in desktop/target/release/bundle
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `librsvg2-dev`.

### Tests

```
npm test             # frontend: state, undo journal, edit logic
cargo test           # engine: metadata reading and output paths
```

The frontend tests run on Node, with no dependencies and no build
step. They cover the modules that never touch the DOM (`state.js` and
`edits.js`).

### Building the wasm from scratch

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128
./build-wasm.sh
```

## Keyboard

| | |
|---|---|
| `Space` | preview the selected photo (`←` `→` step, `Esc` closes) |
| double-click | show a photo in the other view |
| `M` / `T` | enlarge the map / the timeline |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `↑` `↓` in the photo list | select next (`Shift` extends, `Ctrl` only moves, `Ctrl+Space` toggles) |
| `Ctrl+A` | select every photo the list shows |
| `Ctrl+S` | save |
| `←` `→` | shift selection 1 min (`Shift` = 10 s) |
| `Esc` | clear selection |
| click / `Shift`+click / `Ctrl`+click | select / range / toggle |
| `?` | list of shortcuts |

## Layout

```
app/                    frontend, plain ES modules, no build step
  backend.js            the seam, Tauri IPC or WASM behind one interface
  state.js              shared state, wall-clock helpers, undo journal
  edits.js              pure edit logic: shift parsing, date/time merging
  strip.js              photo list: order, filters, search, dragging photos out
  map.js                Leaflet view, clustering, drag, route interpolation
  search.js             place search (Photon)
  timeline.js           continuous track, rows, group time shift, batch dating
  datetime.js           keyboard-driven date-time field and calendar
  preview.js            hover previews and the lightbox
  stage.js              map/timeline split: enlarge a pane, drag the divider
  dom.js                small DOM helpers: saved settings, drag handles
  app.js                wiring: loading, inspector, previews, keyboard, save
  vendor/               Leaflet, Leaflet.markercluster and the three web fonts
  wasm/                 generated by ./build-wasm.sh
test/                   node --test over the DOM-free modules
engine/src/lib.rs       the metadata engine, shared by both targets (unit-tested)
engine-wasm/src/lib.rs  wasm-bindgen wrapper over engine, no logic of its own
desktop/src/
  exif.rs               file I/O around the engine
  thumb.rs              thumbnail decode
  paths.rs              output paths + collision handling (unit-tested)
  lib.rs                Tauri commands
```
