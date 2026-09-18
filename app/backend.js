/* Backend adapter.
 *
 * The map and timeline views never learn which backend they are driving. Two
 * implementations satisfy the same interface:
 *
 *   tauri   desktop, folders and files anywhere on disk
 *   web     browser, folders and files the user picks
 *
 * Both run the same metadata engine (img-taggr-core); they differ only in how
 * files reach it.
 *
 * They differ in what they *can* do, so each advertises `caps` and the UI
 * adapts rather than offering controls that cannot work.
 *
 * Saving has one shape everywhere: the tagged files are written as a new set
 * into a folder of their own, and the sources are never opened for writing.
 *
 * Interface:
 *   id, envWarning()
 *   caps.outputFolder       can write into a folder at all (else: a download)
 *   caps.outputPaths        the output field holds a full path, not a name
 *   pickFolder() / pickFiles()
 *                           -> {label, photos, unreadable, activate?} | null
 *                              the app calls activate() once it takes the
 *                              photos, so a declined source changes nothing
 *   watchDrop({hover, drop}) calls drop(Promise<{label, photos} | null>), for a
 *                           drop and for a chooser whose files arrived after
 *                           the add stopped waiting for them
 *   forget(ids)             the app dropped these photos; release them
 *   reset()                 the app emptied the session
 *   guardClose({dirty, confirm}) ask before closing with unsaved edits
 *   loadThumb(photo)        -> data URL | null
 *   loadPreview(photo)      -> URL of a full-size image | null
 *   suggestOutput(label)    -> string
 *   outputParent()          -> name of the folder the new one is made in, or null
 *   pickOutput()            -> {path} | {parent} | null
 *                              `path` names the output folder outright,
 *                              `parent` only says what it will be made inside
 *   save(items, {outDir})   -> {results: [{path, ok, error}], destination}
 *                              destination is where the files were written;
 *                              a browser without write access downloads a
 *                              ZIP instead of writing to the folder
 */

/** Extensions the desktop picker offers, pinned by a test to `SUPPORTED` in
 *  `desktop/src/lib.rs` and `WRITABLE` in `engine/src/lib.rs`. The browser asks
 *  the wasm engine instead. */
export const IMAGE_EXTS = [
  'jpg', 'jpeg', 'heic', 'heif', 'png', 'tif', 'tiff', 'webp',
];

/** Long edge of a thumbnail, in pixels. The desktop engine renders to the same
 *  number in desktop/src/thumb.rs, so a card looks the same in both builds. A
 *  card is at most 132 CSS px wide, which this covers on a 3x display. */
const THUMB_EDGE = 384;

/* ── Output names ──────────────────────────────────────────────── */
/* The output folder is flat, so two sources holding an `IMG_1.jpg` must not
   become one file. `create_dest` in `desktop/src/paths.rs` answers the same
   question for the desktop build, against the real filesystem. */

/** `name`, or `name (1)`, `name (2)`… — the first the caller has not taken. */
export function freeName(name, taken) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let out = name;
  for (let n = 1; taken.has(out); n++) out = `${stem} (${n})${ext}`;
  taken.add(out);
  return out;
}

/**
 * The same, but asking `dir` what it already holds as well as `taken`, so the
 * name it returns is free in both. A check the directory cannot answer counts
 * as taken.
 */
export async function freeNameIn(dir, name, taken) {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 0; n < 10_000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    if (taken.has(candidate)) continue;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      // Only NotFoundError means the name is free. Any other error (a directory
      // has that name, permission was revoked) counts as taken.
      if (e?.name === 'NotFoundError') {
        taken.add(candidate);
        return candidate;
      }
      continue;
    }
  }
  throw new Error('too many files of the same name in the output folder');
}

/** Where a save put the files, for the message afterwards. */
const wroteTo = (label) => ({ kind: 'folder', label });
const downloaded = (label) => ({ kind: 'download', label });

/* ── Desktop (Tauri) ───────────────────────────────────────────── */

function tauriBackend() {
  const invoke = window.__TAURI__.core.invoke;
  const dialog = window.__TAURI__.dialog;

  /** Read a batch of sources, each a folder or a loose file. */
  async function scan(paths) {
    const list = [paths].flat().filter(Boolean);
    if (!list.length) return null;
    const res = await invoke('scan_paths', { paths: list, recursive: true });
    return { label: res.folder, photos: res.photos, unreadable: res.unreadable };
  }

  return {
    id: 'tauri',
    caps: {
      outputFolder: true,
      // The output field holds a full path here, which the picker fills in.
      outputPaths: true,
    },

    async envWarning() {
      return null; // nothing to install: the engine is compiled in
    },

    async pickFolder() {
      return scan(await dialog.open({
        directory: true, multiple: true, title: 'Add a photo folder',
      }));
    },

    async pickFiles() {
      return scan(await dialog.open({
        multiple: true,
        title: 'Add photos',
        filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
      }));
    },

    watchDrop({ hover, drop }) {
      // The webview swallows HTML drop events and reports native paths instead.
      window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter') hover(true);
        else if (payload.type === 'leave') hover(false);
        else if (payload.type === 'drop') {
          hover(false);
          // One drop can contain folders and files; scan_paths handles both.
          if (payload.paths.length) drop(scan(payload.paths));
        }
      });
    },

    // Nothing is held open between calls: every read goes back to the file.
    forget() {},
    reset() {},

    loadThumb(photo) {
      return invoke('load_thumb', { path: photo.path, orientation: photo.orientation ?? 1 });
    },

    loadPreview(photo) {
      return invoke('load_preview', { path: photo.path, orientation: photo.orientation ?? 1 });
    },

    suggestOutput(label) {
      return invoke('suggest_out_dir', { folder: label });
    },

    outputParent() {
      return null; // the output field already holds the full path
    },

    async pickOutput() {
      const dir = await dialog.open({ directory: true, multiple: false, title: 'Output folder' });
      return dir ? { path: dir } : null;
    },

    guardClose({ dirty, confirm }) {
      // The handler is awaited; unless it prevents the close, Tauri destroys the window.
      window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (e) => {
        if (dirty() && !(await confirm())) e.preventDefault();
      });
    },

    async save(items, { outDir }) {
      const results = await invoke('apply_edits', { items, outDir });
      return { results, destination: wroteTo(outDir) };
    },
  };
}

/* ── Browser (WASM) ────────────────────────────────────────────── */

async function webBackend() {
  const wasm = await import('./wasm/img_taggr_wasm.js');
  await wasm.default('./wasm/img_taggr_wasm_bg.wasm');

  // The writable extensions come from the engine.
  const exts = wasm.writable_extensions().split(',');
  const extOf = (n) => (n.split('.').pop() || '').toLowerCase();

  /** photo id -> File. Bytes are re-read on demand rather than held in memory;
   *  a File object holds no bytes itself. */
  const files = new Map();
  /** Directory handle when the browser supports writing back in place. */
  let outHandle = null;
  /** Where photos nobody is waiting for go in: a drop, or a chooser that
   *  produced its files after the add gave up. Set by watchDrop. */
  let announce = null;
  /** photo id -> object URL for the lightbox. */
  const previews = new Map();
  const canWriteFiles = typeof window.showDirectoryPicker === 'function';

  function describe(file, id, bytes) {
    let meta = {};
    try {
      meta = JSON.parse(wasm.read_meta(bytes, file.name) || '{}');
    } catch {
      // A file with unparseable metadata still joins the list, with empty fields.
    }
    return {
      path: id,
      name: file.name,
      ext: meta.ext || extOf(file.name),
      datetime: meta.datetime ?? null,
      offset: meta.offset ?? null,
      lat: meta.lat ?? null,
      lon: meta.lon ?? null,
      orientation: meta.orientation ?? 1,
      // Browsers expose lastModified, the web equivalent of file mtime, and the
      // fallback the timeline seeds undated photos from.
      file_modified: file.lastModified
        ? new Date(file.lastModified).toISOString().slice(0, 19)
        : null,
    };
  }

  /** What makes two picked files the same photo: relative path, size and mtime,
   *  since a browser gives no stable file id. */
  const idOf = (f) => `${f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}`;

  /** Read a set of files. Nothing about the session changes until the app calls
   *  activate(), so a source it declines leaves the current one intact. */
  async function ingest(fileList, label, handle = null) {
    const accepted = [...fileList].filter((f) => wasm.supported(f.name));
    const found = new Map();
    const photos = [];
    for (const f of accepted) {
      const id = idOf(f);
      if (found.has(id)) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      // Files the engine could never write back count as unreadable.
      if (wasm.reject_reason(bytes, f.name)) continue;
      found.set(id, f);
      photos.push(describe(f, id, bytes));
    }
    return {
      label,
      photos,
      unreadable: fileList.length - photos.length,
      activate() {
        for (const [id, f] of found) files.set(id, f);
        // The first folder handle held is where the output folder is made;
        // later sources never move it.
        if (handle && !outHandle) outHandle = handle;
      },
    };
  }

  /** Every file directly inside a directory handle, as the picker sees it. */
  async function filesIn(dir) {
    const picked = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') picked.push(await entry.getFile());
    }
    return picked;
  }

  /** Same, for the older entry API that browsers without handles expose. */
  async function filesInEntry(dir) {
    const reader = dir.createReader();
    const entries = [];
    for (let batch; (batch = await new Promise((ok, fail) => reader.readEntries(ok, fail))).length;) {
      entries.push(...batch);
    }
    return Promise.all(entries.filter((e) => e.isFile)
      .map((e) => new Promise((ok, fail) => e.file(ok, fail))));
  }

  /** How long a closed chooser gets to produce files before the add stops
   *  waiting on it. */
  const PICK_GRACE_MS = 1200;

  /** Ingest a FileList from the input fallback. For a folder pick, the label is
   *  the first segment of the first file's `webkitRelativePath`. */
  function fromInput(files, directory) {
    if (!files?.length) return null;
    const label = directory
      ? files[0].webkitRelativePath?.split('/')[0] || 'photos'
      : 'photos';
    return ingest(files, label);
  }

  /** The input from the last fallback pick, kept while its files may still be
   *  coming. Only one pick is outstanding at a time, so the next one clears it. */
  let strayInput = null;

  /**
   * Opens a chooser through a hidden `<input type=file>`, for browsers with no
   * File System Access API. Resolves to the chosen FileList, or to null once
   * the grace period passes with nothing chosen. Files that arrive after that
   * are announced instead, the way a drop is.
   */
  function pickViaInput({ directory }) {
    strayInput?.remove();
    const input = document.createElement('input');
    strayInput = input;
    input.type = 'file';
    input.multiple = true;
    if (directory) input.webkitdirectory = true;
    input.accept = exts.map((e) => `.${e}`).join(',');
    input.style.display = 'none';
    document.body.append(input);

    return new Promise((resolve) => {
      let waiting = true;
      const answer = (v) => {
        if (!waiting) return false;
        waiting = false;
        resolve(v);
        return true;
      };
      const close = () => {
        if (strayInput === input) strayInput = null;
        input.remove();
      };

      input.onchange = () => {
        const { files } = input;
        if (!answer(files) && files?.length) announce?.(fromInput(files, directory));
        close();
      };
      input.oncancel = () => { answer(null); close(); };

      // Brave fires no `cancel` for a directory chooser, and Chromium opens its
      // upload confirmation only after focus returns, so no single event marks
      // the end of a pick: focus bounds the wait, `change` above still delivers.
      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (input.files?.length) { answer(input.files); close(); return; }
          answer(null);
        }, PICK_GRACE_MS);
      }, { once: true });

      input.click();
    });
  }

  /**
   * Read a drop, which can mix folders and loose files. The caller has already
   * copied everything off the DataTransfer, since its items are unreadable once
   * the event handler returns.
   */
  async function readDrop(items) {
    const dirs = [];
    const loose = [];
    for (const it of items) {
      const handle = await it.handle;
      if (handle?.kind === 'directory') dirs.push(handle);
      else if (it.entry?.isDirectory) dirs.push(it.entry);
      else if (it.file) loose.push(it.file);
    }

    const picked = [...loose];
    for (const d of dirs) {
      picked.push(...(d.kind === 'directory' ? await filesIn(d) : await filesInEntry(d)));
    }
    if (!picked.length) return null;

    const label = dirs.length === 1 && !loose.length ? dirs[0].name
      : dirs.length ? 'dropped folders' : 'dropped photos';
    // Only a drop of exactly one folder keeps its handle.
    const handle = dirs.length === 1 && dirs[0].kind === 'directory' ? dirs[0] : null;
    return ingest(picked, label, handle);
  }

  return {
    id: 'web',
    caps: {
      // Writing back to a folder needs the File System Access API.
      outputFolder: canWriteFiles,
      // A browser exposes directory handles, never filesystem paths.
      outputPaths: false,
    },

    async envWarning() {
      return canWriteFiles
        ? null
        : 'This browser cannot write files directly, so saving will download a ZIP instead. Chrome or Edge can save straight to a folder.';
    },

    async pickFolder() {
      // Prefer the directory picker: it preserves folder structure and is the
      // only route to writing results back without a download.
      if (canWriteFiles) {
        let dir;
        try {
          dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch {
          return null; // dismissed or refused
        }
        return ingest(await filesIn(dir), dir.name, dir);
      }

      return fromInput(await pickViaInput({ directory: true }), true);
    },

    async pickFiles() {
      if (typeof window.showOpenFilePicker === 'function') {
        let handles;
        try {
          handles = await window.showOpenFilePicker({
            multiple: true,
            types: [{ description: 'Images', accept: { 'image/*': exts.map((e) => `.${e}`) } }],
          });
        } catch {
          return null; // dismissed or refused
        }
        // Picked files come with no directory handle, so the output location is unchanged.
        return ingest(await Promise.all(handles.map((h) => h.getFile())), 'photos');
      }

      return fromInput(await pickViaInput({ directory: false }), false);
    },

    watchDrop({ hover, drop }) {
      // Also the way a late chooser gets its photos in; see pickViaInput.
      announce = drop;
      // Internal drags use pointer events, so a Files payload is always from outside.
      const isFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
      let depth = 0;
      window.addEventListener('dragenter', (e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        if (depth++ === 0) hover(true);
      });
      window.addEventListener('dragleave', (e) => {
        if (isFiles(e) && --depth === 0) hover(false);
      });
      window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
      window.addEventListener('drop', (e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        depth = 0;
        hover(false);
        // DataTransfer items are unreadable once the handler returns, so copy
        // them synchronously and process them afterwards.
        drop(readDrop([...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => ({
          handle: i.getAsFileSystemHandle?.().catch(() => null),
          entry: i.webkitGetAsEntry?.(),
          file: i.getAsFile(),
        }))));
      });
    },

    /** These photos left the session, so let go of their bytes and previews. */
    forget(ids) {
      for (const id of ids) {
        files.delete(id);
        const url = previews.get(id);
        if (url) { URL.revokeObjectURL(url); previews.delete(id); }
      }
    },

    reset() {
      files.clear();
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
      outHandle = null;
    },

    async loadPreview(photo) {
      const file = files.get(photo.path);
      if (!file) return null;
      // The browser decodes and orients it; an object URL only references the
      // File, so keeping one per photo costs nothing.
      if (!previews.has(photo.path)) previews.set(photo.path, URL.createObjectURL(file));
      return previews.get(photo.path);
    },

    async loadThumb(photo) {
      const file = files.get(photo.path);
      if (!file) return null;
      try {
        // 'from-image' applies the EXIF orientation, so the thumbnail is upright
        // without us rotating pixels by hand.
        const bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          // Decoding straight to this width keeps a 40-megapixel photo from
          // being built full-size first; a portrait one is still taller than
          // the long edge, so the canvas below finishes the job.
          resizeWidth: THUMB_EDGE,
          resizeQuality: 'medium',
        });
        const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        return c.toDataURL('image/jpeg', 0.78);
      } catch {
        // Chrome cannot decode HEIC; the UI falls back to a filename tile.
        return null;
      }
    },

    suggestOutput(label) {
      return `${label}_tagged`;
    },

    outputParent() {
      return outHandle?.name ?? null;
    },

    guardClose({ dirty }) {
      // Browsers only allow their own generic prompt here.
      window.addEventListener('beforeunload', (e) => {
        if (dirty()) e.preventDefault();
      });
    },

    async pickOutput() {
      if (!canWriteFiles) return null;
      try {
        outHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        return { parent: outHandle.name };
      } catch {
        return null;
      }
    },

    async save(items, { outDir }) {
      // A dropped folder has no write permission. Requesting it needs user
      // activation, which the Save click provides only until the first await.
      let dest = outHandle;
      try {
        if (dest && await dest.requestPermission({ mode: 'readwrite' }) !== 'granted') dest = null;
      } catch { dest = null; }

      const results = [];
      const written = [];

      for (const it of items) {
        const file = files.get(it.path);
        if (!file) {
          results.push({ path: it.path, ok: false, error: 'file no longer available' });
          continue;
        }
        try {
          const out = wasm.write_meta(
            new Uint8Array(await file.arrayBuffer()), file.name,
            it.datetime ?? '', it.offset ?? '',
            it.lat ?? 0, it.lon ?? 0,
            it.lat != null && it.lon != null,
            !!it.clear_gps,
          );
          written.push({ name: file.name, bytes: out });
          results.push({ path: it.path, ok: true, error: null });
        } catch (e) {
          results.push({ path: it.path, ok: false, error: String(e?.message ?? e) });
        }
      }

      const folder = outDir || 'tagged';
      if (!written.length) return { results, destination: wroteTo(folder) };

      if (dest) {
        try {
          const target = await dest.getDirectoryHandle(folder, { create: true });
          const used = new Set();
          for (const w of written) {
            const name = await freeNameIn(target, w.name, used);
            const fh = await target.getFileHandle(name, { create: true });
            const s = await fh.createWritable();
            await s.write(w.bytes);
            await s.close();
          }
          return { results, destination: wroteTo(folder) };
        } catch (e) {
          // Permission withdrawn or quota hit, so fall through to the download
          // path rather than losing the user's work.
          console.warn('direct write failed, falling back to download', e);
        }
      }

      // Report the ZIP, not the folder that was asked for.
      const zip = `${folder}.zip`;
      const taken = new Set();
      downloadZip(written.map((w) => ({ ...w, name: freeName(w.name, taken) })), zip);
      return { results, destination: downloaded(zip) };
    },
  };
}

/* ── Minimal store-only ZIP ────────────────────────────────────── */
/* Entries are stored uncompressed, since images already are. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The current time as DOS date and time words, the ZIP timestamp format. Zero
 *  words would give extracted files a 1980 timestamp. */
function dosTime() {
  const d = new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function downloadZip(entries, zipName) {
  const enc = new TextEncoder();
  const { time: dosT, date: dosD } = dosTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 filename flag
    local.setUint16(8, 0, true);           // stored, no compression
    local.setUint16(10, dosT, true);
    local.setUint16(12, dosD, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);

    chunks.push(new Uint8Array(local.buffer), nameBytes, e.bytes);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, dosT, true);
    cen.setUint16(14, dosD, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const blob = new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
    { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ── Selection ─────────────────────────────────────────────────── */

export function createBackend() {
  // Tauri injects __TAURI__ before any module runs, so its presence is the
  // reliable signal for which host we are in.
  return window.__TAURI__ ? tauriBackend() : webBackend();
}
