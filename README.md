# img-taggr

Edit photo **time, date and location** metadata through a **map** and a
**timeline** view.

Scanned film comes back with no EXIF at all. A camera with the wrong clock
stamps a whole trip an hour out. Fixing either one photo at a time is the
problem this solves: you place two shots on a map and interpolate the walk
between them, or drag a whole selection along the timeline and keep the
intervals intact.

Runs two ways from one codebase, as a website with no server or as a desktop
app.

**[Try it in your browser](https://julespatmanidis.github.io/img_taggr/)** (no
install, no upload, the photos stay on your machine)

<img src="docs/imgs/placed.png" width="820" alt="img-taggr with photos placed on the map and dated on the timeline">

> **Status:** early. Version 0.1.0, Linux desktop and Chromium browsers are what
> gets used daily. The default save mode writes copies and never touches your
> originals, but back up anything irreplaceable before pointing a metadata
> editor at it.

## Formats

| Format | Read | Write | Thumbnail |
|---|---|---|---|
| JPEG, PNG | yes | yes | yes |
| WebP (lossless) | yes | yes | yes |
| TIFF, HEIC/HEIF | yes | yes | no (see below) |
| RAW, lossy WebP | no | no | no |

HEIC and TIFF have no thumbnails, since neither the browser nor the `image`
crate can decode them. Safari decodes HEIC on its own in the web build.

## Quickstart

### Web

The compiled engine is committed, so running it needs nothing but Python:

```
./dev-server.py      # serves app/ on http://localhost:8080
```

Use the plain `python3 -m http.server` instead and save-to-folder breaks, so
prefer this one (`dev-server.py` explains why in its docstring).

To rebuild the engine after changing the Rust code you need
[Rust](https://rustup.rs) and [Node](https://nodejs.org):

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128

npm run web          # rebuilds the wasm, then serves app/
```

Open a folder with the button or by dropping it onto the window. Chrome and Edge
can save straight back to a folder via the File System Access API. Other
browsers download a ZIP instead (the app detects this and relabels the save
dialog accordingly).

To deploy, publish `app/` as static files. There is no server side. The
included GitHub Actions workflow does exactly that on every push to `main`.

### Desktop

Linux only so far. macOS and Windows are untried, and reports are welcome.
Nothing to install at runtime, since the metadata engine is compiled in.
Building needs [Rust](https://rustup.rs), [Node](https://nodejs.org) and the
Tauri system libraries:

```
sudo dnf install webkit2gtk4.1-devel libsoup3-devel \
                 librsvg2-devel libappindicator-gtk3-devel
npm install
npm run dev          # development window
npm run build        # .deb / .rpm / AppImage in desktop/target/release/bundle
```

Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `librsvg2-dev`.

There are no prebuilt binaries yet, so the desktop app is build-from-source for
now.

## What it does

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
  intervals between shots stay as they were. Hold **Alt** to move one photo out
  of formation.
- Drag across empty track to select the photos inside a box.
- Drop undated photos from the list to date them.
- **Distribute evenly** spaces the selected photos at equal intervals between
  the first and the last, which untangles a burst dropped on one spot.
- Shots that would overlap step down one row each, earliest on top.

**Batch dating.** A folder of scans opens with nothing dated and nothing placed.
**Date this batch** takes a start time and one interval and dates the whole roll
in filename order, which is the order it was shot in.

<img src="docs/imgs/first-run.png" width="820" alt="A freshly opened folder, nothing dated or placed yet">

## Editing model

Wall-clock time and UTC offset are **separate fields**, so correcting one never
silently moves the other.

The inspector on the right edits the selection in place. Date and time are one
`YYYY-MM-DD HH:MM:SS` field. On a mixed selection, changing only the date leaves
each photo its own time. **Shift by** takes `+3h47m`, `-15s` or `-0:15` and
moves every selected photo.

Tags written: `DateTimeOriginal`, `CreateDate`, `ModifyDate`, `OffsetTime*`, and
`GPSLatitude`/`GPSLongitude` with their hemisphere refs. Every other tag in the
file is left as it was.

## Saving

The app stages every change in memory and writes nothing until you press
**Save**. Amber dots show what is still pending, and Ctrl+Z unwinds anything
not yet written.

Three save modes, with the non-destructive one selected by default:

| Mode | What it does |
|---|---|
| **Write copies** (default) | Tagged files go to a new folder. Originals never opened for writing. |
| **Edit in place, keep backups** | Each original is preserved as `name.ext_original`, the same convention exiftool uses. |
| **Edit in place** | Overwrites originals. No undo once written. |

The web build only offers copies, because the browser never holds the
originals.

## Privacy

Photos are read locally and never uploaded. There is no server, no account and
no telemetry, in either build.

One exception, stated plainly: the place search box sends what you type to
[photon.komoot.io](https://photon.komoot.io) to turn it into coordinates. It
sends the query text only, never a photo or a coordinate from your set, and
nothing happens until you type in that box.

Map tiles are fetched from their providers as you pan, which is a normal map
request and reveals the area you are looking at, as any map does.

## Keyboard

| Key | Action |
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

## Development

```
npm test             # frontend: state, undo journal, edit logic, save modes
npm run test:rust    # engine metadata handling, desktop output paths
```

The frontend tests run on Node, with no dependencies and no build step. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the module map, the engine seam that lets
one codebase drive both targets, and the conventions worth knowing before
sending a patch.

Issues and pull requests are welcome, particularly build reports from macOS and
Windows.

## License

MIT. See [LICENSE](LICENSE).
