/* Backend adapter.
 *
 * The map and timeline views never learn which backend they are driving. Two
 * implementations satisfy the same interface:
 *
 *   tauri   desktop, real folders, edits originals or copies
 *   web     browser, files the user picks, download or File System Access
 *
 * Both run the same metadata engine (img-taggr-core); they differ only in how
 * files reach it.
 *
 * They differ in what they *can* do, so each advertises `caps` and the UI
 * adapts rather than offering controls that cannot work.
 *
 * Interface:
 *   id, caps, envWarning()
 *   pickSource()            -> {label, photos, activate?} | null
 *                              the app calls activate() once it takes the
 *                              photos, so a declined source changes nothing
 *   watchDrop({hover, drop}) calls drop(Promise<{label, photos} | null>)
 *   guardClose({dirty, confirm}) ask before closing with unsaved edits
 *   loadThumb(photo)        -> data URL | null
 *   loadPreview(photo)      -> URL of a full-size image | null
 *   suggestOutput(label)    -> string
 *   save(items, {mode, outDir})
 *                           -> {results: [{path, ok, error}], destination}
 *                              destination says where the files landed,
 *                              which is not always where they were asked
 *                              to go (see SAVE_MODES below).
 */

/* ── Save modes ────────────────────────────────────────────────── */

/**
 * Every save mode there is, declared once. The radio list is rendered from
 * this, and `desktop/src/lib.rs` matches the same ids exhaustively, so a mode
 * cannot exist in one half of the app and not the other.
 *
 * `needsOutDir`     the mode writes somewhere else, so it needs a destination
 * `writesOriginals` the source files are opened for writing
 * `destructive`     ...and not recoverable afterwards
 */
export const SAVE_MODES = [
  {
    id: 'copy',
    label: 'Write copies',
    hint: 'Originals untouched; tagged files go to a new folder.',
    needsOutDir: true, writesOriginals: false, destructive: false,
  },
  {
    id: 'backup',
    label: 'Edit in place, keep backups',
    hint: 'Each original is preserved as `name.ext_original`.',
    needsOutDir: false, writesOriginals: true, destructive: false,
  },
  {
    id: 'inplace',
    label: 'Edit in place',
    hint: 'Overwrites originals. No undo once written.',
    needsOutDir: false, writesOriginals: true, destructive: true,
  },
];

/** The mode with this id. Unknown ids are a programming error, not input: the
 *  destructive mode must never be something you reach by mistyping. */
export function saveMode(id) {
  const mode = SAVE_MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`unknown save mode: ${id}`);
  return mode;
}

/** The modes a backend can perform, in the order the save sheet lists them. */
export const modesFor = (caps) => SAVE_MODES.filter((m) => caps.saveModes.includes(m.id));

/** Long edge of a thumbnail, in pixels. The desktop engine renders to the same
 *  number in desktop/src/thumb.rs, so a card looks the same in both builds. A
 *  card is at most 132 CSS px wide, which this covers on a 3x display. */
const THUMB_EDGE = 384;

/** Where a save put the files, for the message afterwards. */
const wroteTo = (label) => ({ kind: 'folder', label });
const downloaded = (label) => ({ kind: 'download', label });
const editedOriginals = () => ({ kind: 'originals', label: null });

/* ── Desktop (Tauri) ───────────────────────────────────────────── */

function tauriBackend() {
  const invoke = window.__TAURI__.core.invoke;
  const dialog = window.__TAURI__.dialog;

  async function scan(path) {
    const res = await invoke('scan_folder', { path, recursive: true });
    return { label: res.folder, photos: res.photos, unreadable: res.unreadable };
  }

  return {
    id: 'tauri',
    caps: {
      // Save modes this backend can perform, in the order the save sheet lists.
      saveModes: ['copy', 'backup', 'inplace'],
      outputFolder: true,
    },

    async envWarning() {
      return null; // nothing to install: the engine is compiled in
    },

    async pickSource() {
      const picked = await dialog.open({
        directory: true, multiple: false, title: 'Choose a photo folder',
      });
      return picked ? scan(picked) : null;
    },

    watchDrop({ hover, drop }) {
      // The webview swallows HTML drop events and reports native paths instead.
      window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter') hover(true);
        else if (payload.type === 'leave') hover(false);
        else if (payload.type === 'drop') {
          hover(false);
          // Anything but a folder is reported by the scan itself.
          if (payload.paths.length) drop(scan(payload.paths[0]));
        }
      });
    },

    loadThumb(photo) {
      return invoke('load_thumb', { path: photo.path, orientation: photo.orientation ?? 1 });
    },

    loadPreview(photo) {
      return invoke('load_preview', { path: photo.path, orientation: photo.orientation ?? 1 });
    },

    suggestOutput(label) {
      return invoke('suggest_out_dir', { folder: label });
    },

    async pickOutput() {
      return dialog.open({ directory: true, multiple: false, title: 'Output folder' });
    },

    guardClose({ dirty, confirm }) {
      // The handler is awaited; unless it prevents the close, Tauri destroys the window.
      window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (e) => {
        if (dirty() && !(await confirm())) e.preventDefault();
      });
    },

    async save(items, { mode, outDir }) {
      const copies = saveMode(mode).needsOutDir;
      const results = await invoke('apply_edits', {
        items, mode, outDir: copies ? outDir : null,
      });
      return { results, destination: copies ? wroteTo(outDir) : editedOriginals() };
    },
  };
}

/* ── Browser (WASM) ────────────────────────────────────────────── */

async function webBackend() {
  const wasm = await import('./wasm/img_taggr_wasm.js');
  await wasm.default('./wasm/img_taggr_wasm_bg.wasm');

  // The engine is the authority on what it can write; the UI never keeps its
  // own copy of the list, so the two cannot drift apart.
  const exts = wasm.writable_extensions().split(',');
  const extOf = (n) => (n.split('.').pop() || '').toLowerCase();

  /** photo id -> File. Bytes are re-read on demand so a big folder does not
   *  sit in memory; the File handle itself is cheap. */
  const files = new Map();
  /** Directory handle when the browser supports writing back in place. */
  let outHandle = null;
  /** photo id -> object URL for the lightbox. */
  const previews = new Map();
  const canWriteFiles = typeof window.showDirectoryPicker === 'function';

  function describe(file, id, bytes) {
    let meta = {};
    try {
      meta = JSON.parse(wasm.read_meta(bytes, file.name) || '{}');
    } catch {
      // A file we cannot parse still belongs in the list, since the user may be
      // here precisely because its metadata is broken.
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

  /** Read a set of files. Nothing about the open session changes until the
   *  app calls activate(), so a source it declines leaves the old one intact. */
  async function ingest(fileList, label, handle = null) {
    const accepted = [...fileList].filter((f) => wasm.supported(f.name));
    const found = new Map();
    const photos = [];
    let seq = 0;
    for (const f of accepted) {
      // webkitRelativePath keeps folder structure visible and ids unique; a
      // plain multi-file pick has none, so fall back to a counter.
      const id = f.webkitRelativePath || `${f.name}#${seq++}`;
      const bytes = new Uint8Array(await f.arrayBuffer());
      // Some files pass the extension check but could never be written back.
      // Leaving them out here is kinder than accepting edits and failing at
      // save, and they land in the unreadable count below.
      if (wasm.reject_reason(bytes, f.name)) continue;
      found.set(id, f);
      photos.push(describe(f, id, bytes));
    }
    return {
      label,
      photos,
      unreadable: fileList.length - photos.length,
      activate() {
        files.clear();
        for (const [id, f] of found) files.set(id, f);
        for (const url of previews.values()) URL.revokeObjectURL(url);
        previews.clear();
        outHandle = handle;
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

  async function readDrop({ handle, entry, loose }) {
    // One folder opens like the picker would, keeping its handle so saving can
    // write back beside it. Loose files open as they are.
    const dir = await handle;
    if (dir?.kind === 'directory') {
      return ingest(await filesIn(dir), dir.name, dir);
    }
    if (entry?.isDirectory) {
      return ingest(await filesInEntry(entry), entry.name);
    }
    if (!loose.length) return null;
    return ingest(loose, 'dropped photos');
  }

  return {
    id: 'web',
    caps: {
      // The browser never holds the originals, so copies are the only option.
      saveModes: ['copy'],
      // Writing back to a folder needs the File System Access API.
      outputFolder: canWriteFiles,
    },

    async envWarning() {
      return canWriteFiles
        ? null
        : 'This browser cannot write files directly, so saving will download a ZIP instead. Chrome or Edge can save straight to a folder.';
    },

    async pickSource() {
      // Prefer the directory picker: it preserves folder structure and is the
      // only route to writing results back without a download.
      if (canWriteFiles) {
        let dir;
        try {
          dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch {
          return null; // user dismissed
        }
        return ingest(await filesIn(dir), dir.name, dir);
      }

      // Fallback: a directory input. Works everywhere, no write access.
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.webkitdirectory = true;
      input.accept = exts.map((e) => `.${e}`).join(',');
      input.style.display = 'none';
      document.body.append(input);
      let chosen;
      try {
        chosen = await new Promise((resolve) => {
          let settled = false;
          const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
          input.onchange = () => finish(input.files);
          input.oncancel = () => finish(null);
          // Not every browser fires `cancel` for a *directory* picker (Brave
          // does not), and this promise is what the whole
          // open waits on. Without a second way out, dismissing the chooser
          // hangs the open for ever: the folder label sits on "Reading…" and
          // the button stays disabled, so the app looks dead from then on.
          // Focus coming back means the chooser has closed; give `change` a
          // moment to land first, and if nothing arrived it was dismissed.
          window.addEventListener('focus', () => {
            setTimeout(() => finish(input.files?.length ? input.files : null), 500);
          }, { once: true });
          input.click();
        });
      } finally {
        input.remove();
      }
      if (!chosen || !chosen.length) return null;
      const root = chosen[0].webkitRelativePath?.split('/')[0] || 'photos';
      return ingest(chosen, root);
    },

    watchDrop({ hover, drop }) {
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
        // DataTransfer items go dead once the event returns, so take everything
        // synchronously and resolve it afterwards.
        const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
        const first = items.length === 1 ? items[0] : null;
        drop(readDrop({
          handle: first?.getAsFileSystemHandle?.().catch(() => null),
          entry: first?.webkitGetAsEntry?.(),
          loose: items.map((i) => i.getAsFile()).filter(Boolean),
        }));
      });
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
        return outHandle.name;
      } catch {
        return null;
      }
    },

    async save(items, { outDir }) {
      // A dropped folder comes without write access; the Save click only counts
      // as the gesture a permission prompt needs until the first slow await.
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
          for (const w of written) {
            const fh = await target.getFileHandle(w.name, { create: true });
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

      // The write landed, but not where the user asked. Say so, or the message
      // names a folder they will not find the files in.
      const zip = `${folder}.zip`;
      downloadZip(written, zip);
      return { results, destination: downloaded(zip) };
    },
  };
}

/* ── Minimal store-only ZIP ────────────────────────────────────── */
/* Images are already compressed, so storing costs nothing and avoids pulling
   in a compression library for the download fallback. */

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

/** ZIP stores timestamps as DOS date/time words; leaving them zero makes
 *  extracted files claim to be from 1980 (or worse, after normalisation). */
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
