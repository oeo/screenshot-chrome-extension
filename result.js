// Result page: stitches the captured viewport frames into the final image(s),
// shows a preview and offers download / copy.
'use strict';

// Chrome's canvas limits: 65535px per side and 16384 x 16384 px of area.
// Taller pages are split into several images instead of being cut off (and
// if a canvas of that size cannot be allocated, smaller pieces are used).
const MAX_CANVAS_SIDE = 65535;
const MAX_CANVAS_AREA = 16384 * 16384;

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  tiles: [], // [{ blob, width, height, url }]
};

main().catch(showError);

async function main() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    showError(params.get('error'));
    return;
  }
  const id = params.get('id');
  const meta = id && await ShotDB.get(`${id}:meta`);
  if (!meta) {
    showError('This screenshot is no longer available. Please capture the page again.');
    return;
  }
  state.meta = meta;
  $('title').textContent = meta.title || meta.url || 'Full Page Screenshot';
  document.title = 'Screenshot – ' + (meta.title || meta.url || '');

  if (!meta.tiles) {
    meta.tiles = await stitch(meta, (done, total) => {
      $('status-text').textContent = `Building your screenshot… ${Math.round((done / total) * 100)}%`;
    });
    await ShotDB.put(`${id}:meta`, meta);
    await ShotDB.delPrefix(`${id}:frame:`);
  }

  for (let i = 0; i < meta.tiles.length; i++) {
    const blob = await ShotDB.get(`${id}:tile:${i}`);
    if (!blob) throw new Error('This screenshot is no longer available. Please capture the page again.');
    state.tiles.push({ blob, ...meta.tiles[i], url: URL.createObjectURL(blob) });
  }
  render();
}

function showError(err) {
  const message = String((err && err.message) || err);
  $('spinner').hidden = true;
  $('status').hidden = false;
  $('status').classList.add('error');
  $('status-text').textContent = message;
  $('title').textContent = 'Screenshot failed';
  document.body.dataset.state = 'error';
}

// ----------------------------------------------------------------- stitch

async function stitch(meta, onProgress) {
  const id = meta.id;
  const loadFrame = async (i) => {
    const blob = await ShotDB.get(`${id}:frame:${i}`);
    if (!blob) throw new Error('The captured data is incomplete. Please capture the page again.');
    return createImageBitmap(blob);
  };

  const first = await loadFrame(0);
  const BW = first.width, BH = first.height;
  first.close();

  // CSS px -> image px. devicePixelRatio is exact (it includes page zoom);
  // fall back to the measured ratio if the capture does not match it.
  const scale = Math.abs(BW - meta.vw * meta.dpr) <= Math.max(2, meta.dpr)
    ? meta.dpr
    : BW / (meta.vvw && Math.abs(meta.vvw - meta.vw) <= 1 ? meta.vvw : meta.vw);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const frames = meta.frames.map((f) => {
    const offX = Math.round(f.x * scale);
    const offY = Math.round(f.y * scale);
    let sx = 0, sy = 0, ex = BW, ey = BH;
    if (!meta.isRoot) {
      // Only whole pixels that lie inside the scrolled element.
      sx = clamp(Math.ceil(f.crop.x * scale - 0.01), 0, BW);
      sy = clamp(Math.ceil(f.crop.y * scale - 0.01), 0, BH);
      ex = clamp(Math.floor((f.crop.x + f.crop.w) * scale + 0.01), sx, BW);
      ey = clamp(Math.floor((f.crop.y + f.crop.h) * scale + 0.01), sy, BH);
    }
    return { offX, offY, sx, sy, ex, ey };
  });

  const maxOffX = Math.max(...frames.map((f) => f.offX));
  const maxOffY = Math.max(...frames.map((f) => f.offY));
  const W = Math.min(BW + maxOffX, MAX_CANVAS_SIDE);
  const H = BH + maxOffY;

  // Draw operations, in paint order (later ones paint over earlier ones).
  const ops = [];
  const add = (i, sx, sy, sw, sh, dx, dy) => {
    if (sw > 0 && sh > 0) ops.push({ i, sx, sy, sw, sh, dx, dy });
  };
  // 1. The first frame in full: everything around the scrolled area.
  add(0, 0, 0, BW, BH, 0, 0);
  // 2. What lies below / right of the scrolled area, moved to the far end.
  if (!meta.isRoot) {
    const li = frames.length - 1;
    const l = frames[li];
    if (l.offY > 0) add(li, 0, l.ey, BW, BH - l.ey, 0, l.ey + l.offY);
    if (l.offX > 0) add(li, l.ex, 0, BW - l.ex, BH, l.ex + l.offX, l.offY);
  }
  // 3. The scrolled area of every frame at its true position.
  frames.forEach((f, i) => add(i, f.sx, f.sy, f.ex - f.sx, f.ey - f.sy, f.sx + f.offX, f.sy + f.offY));

  let maxTileH = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(MAX_CANVAS_AREA / W)));

  for (;;) {
    const count = Math.ceil(H / maxTileH);
    const tileH = Math.ceil(H / count);
    const tiles = [];
    let failed = false;
    let done = 0;
    const total = count * ops.length;

    for (let t = 0; t < count && !failed; t++) {
      const top = t * tileH;
      const height = Math.min(tileH, H - top);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { failed = true; break; }
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, height);
      try { ctx.fillStyle = meta.background || '#ffffff'; } catch (_) {}
      ctx.fillRect(0, 0, W, height);

      // Make sure the browser really allocated a canvas this large.
      let alive = false;
      try { alive = ctx.getImageData(W - 1, height - 1, 1, 1).data[3] === 255; } catch (_) {}
      if (!alive) { failed = true; break; }

      let loaded = -1, bitmap = null;
      for (const op of ops) {
        done++;
        if (op.dy + op.sh <= top || op.dy >= top + height) continue;
        if (loaded !== op.i) {
          if (bitmap) bitmap.close();
          bitmap = await loadFrame(op.i);
          loaded = op.i;
          if (bitmap.width !== BW || bitmap.height !== BH) {
            throw new Error('The window size changed during the capture. Please capture the page again.');
          }
          onProgress(done, total);
        }
        ctx.drawImage(bitmap, op.sx, op.sy, op.sw, op.sh, op.dx, op.dy - top, op.sw, op.sh);
      }
      if (bitmap) bitmap.close();

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 0; // release memory right away
      if (!blob) { failed = true; break; }
      await ShotDB.put(`${id}:tile:${t}`, blob);
      tiles.push({ width: W, height });
    }

    if (!failed) return tiles;
    if (maxTileH <= 1024) throw new Error('Not enough memory to build the screenshot.');
    await ShotDB.delPrefix(`${id}:tile:`);
    maxTileH = Math.floor(maxTileH / 2);
  }
}

// ----------------------------------------------------------------- render

function render() {
  const { meta, tiles } = state;
  const multi = tiles.length > 1;
  const totalH = tiles.reduce((sum, t) => sum + t.height, 0);

  $('subtitle').textContent =
    `${tiles[0].width} × ${totalH} px` +
    (multi ? ` · ${tiles.length} images` : '') +
    (meta.url ? ` · ${meta.url}` : '');

  const notes = [];
  if (meta.stopped) notes.push('The capture was stopped early, so the image ends where you stopped it.');
  if (meta.truncated) notes.push('This page is extremely long (or keeps loading more content), so the capture was stopped after ' + meta.frames.length + ' screens.');
  if (multi) notes.push('The page is taller than the largest image a browser can create, so it was split into ' + tiles.length + ' images at full quality.');
  if (notes.length) {
    $('notice').textContent = notes.join(' ');
    $('notice').hidden = false;
  }

  const images = $('images');
  tiles.forEach((tile, i) => {
    const part = document.createElement('section');
    part.className = 'part';
    if (multi) {
      const bar = document.createElement('div');
      bar.className = 'part-bar';
      const label = document.createElement('span');
      label.textContent = `Part ${i + 1} of ${tiles.length} · ${tile.width} × ${tile.height} px`;
      bar.append(
        label,
        button('Download PNG', (b) => act(b, () => downloadPng(i))),
        button('Copy', (b) => act(b, () => copyTile(i), 'Copied'))
      );
      part.append(bar);
    }
    const img = document.createElement('img');
    img.src = tile.url;
    img.alt = multi ? `Screenshot part ${i + 1}` : 'Screenshot';
    img.width = tile.width;
    img.height = tile.height;
    // Show at the page's real size (image pixels / device pixel ratio).
    img.style.width = Math.round(tile.width / (meta.dpr || 1)) + 'px';
    part.append(img);
    images.append(part);
  });

  $('download-png').textContent = multi ? 'Download all (PNG)' : 'Download PNG';
  $('download-jpg').textContent = multi ? 'Download all (JPEG)' : 'Download JPEG';
  $('copy').hidden = multi;
  $('download-png').onclick = (e) => act(e.currentTarget, async () => {
    for (let i = 0; i < tiles.length; i++) { downloadPng(i); if (multi) await pause(400); }
  });
  $('download-jpg').onclick = (e) => act(e.currentTarget, async () => {
    for (let i = 0; i < tiles.length; i++) { await downloadJpeg(i); if (multi) await pause(400); }
  });
  $('copy').onclick = (e) => act(e.currentTarget, () => copyTile(0), 'Copied');

  $('status').hidden = true;
  $('actions').hidden = false;
  document.body.dataset.state = 'done';
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function button(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = () => onClick(b);
  return b;
}

// Run a button action with busy / done / failed feedback on the button.
async function act(btn, fn, doneText) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  let flash = doneText;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    flash = 'Failed';
    btn.title = String((err && err.message) || err);
  }
  if (flash) {
    btn.textContent = flash;
    await pause(1400);
    btn.textContent = label;
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------- actions

function fileName(index, ext) {
  const { meta, tiles } = state;
  let host = '';
  try { host = new URL(meta.url).hostname.replace(/^www\./, ''); } catch (_) {}
  const slug = (s) => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  const d = new Date(meta.createdAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const part = tiles.length > 1 ? `-part${index + 1}of${tiles.length}` : '';
  const name = [slug(host.replace(/\./g, '-')), slug(meta.title), stamp].filter(Boolean).join('_');
  return `${name || 'screenshot'}${part}.${ext}`;
}

function save(blobOrUrl, name) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadPng(i) {
  save(state.tiles[i].url, fileName(i, 'png'));
}

async function downloadJpeg(i) {
  const tile = state.tiles[i];
  const bitmap = await createImageBitmap(tile.blob);
  const canvas = document.createElement('canvas');
  canvas.width = tile.width;
  canvas.height = tile.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not create the JPEG.');
  save(blob, fileName(i, 'jpg'));
}

async function copyTile(i) {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.tiles[i].blob })]);
}
