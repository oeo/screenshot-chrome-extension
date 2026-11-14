// Service worker: drives the capture. It scrolls the page one viewport at a
// time (via page.js), grabs each viewport with captureVisibleTab, stores the
// frames in IndexedDB and then opens result.html, which stitches them.
'use strict';

importScripts('db.js');

// Chrome allows 2 captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Safety net for endless (infinite-scroll) pages.
const MAX_FRAMES = 300;
// Frames overlap by a few CSS pixels so rounding can never leave a gap.
const OVERLAP_PX = 4;
const KEEP_CAPTURES = 5;

let current = null; // { tabId, cancel } - one capture at a time
let lastCaptureAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (promise) => Promise.resolve(promise).catch(() => {});

chrome.action.onClicked.addListener((tab) => { captureTab(tab.id); });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'full-page-shot:cancel' && current && sender.tab &&
      sender.tab.id === current.tabId) {
    current.cancel = true;
  }
});

// Entry point. Clicking the button again while a capture is running stops
// it early and keeps what was captured so far.
async function captureTab(tabId) {
  if (current) {
    if (current.tabId === tabId) current.cancel = true;
    return null;
  }
  const job = { tabId, cancel: false };
  current = job;
  try {
    await quiet(chrome.action.setBadgeBackgroundColor({ color: '#2563eb' }));
    await quiet(chrome.action.setBadgeText({ tabId, text: '…' }));
    await quiet(chrome.action.setTitle({ tabId, title: 'Capturing… click (or press Esc) to stop here' }));
    const tab = await chrome.tabs.get(tabId);
    const id = await capture(tab, job);
    const url = chrome.runtime.getURL('result.html') + '?id=' + encodeURIComponent(id);
    await openTab(url, tab);
    return url;
  } catch (err) {
    const message = friendlyError(err);
    const url = chrome.runtime.getURL('result.html') + '?error=' + encodeURIComponent(message);
    await quiet(chrome.tabs.get(tabId).then((tab) => openTab(url, tab), () => openTab(url, null)));
    return url;
  } finally {
    current = null;
    await quiet(chrome.action.setBadgeText({ tabId, text: '' }));
    await quiet(chrome.action.setTitle({ tabId, title: 'Capture full page screenshot' }));
  }
}

function openTab(url, nextTo) {
  const props = { url };
  if (nextTo) {
    props.windowId = nextTo.windowId;
    props.index = nextTo.index + 1;
    props.openerTabId = nextTo.id;
  }
  return chrome.tabs.create(props).catch(() => chrome.tabs.create({ url }));
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission|must request permission|Cannot script/i.test(msg)) {
    return 'This page cannot be captured. Browsers do not allow extensions to run on ' +
      'built-in pages (settings, new tab, the extension store) or, unless enabled in the ' +
      'extension\'s settings, on local files.';
  }
  if (/No tab with id|Frame with ID 0 (was removed|is showing error page)|Receiving end|context invalidated/i.test(msg)) {
    return 'The page was closed or navigated away during the capture.';
  }
  return msg;
}

async function capture(tab, job) {
  const tabId = tab.id;

  const call = async (method, ...args) => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, a) => (globalThis.__fullPageShot
        ? globalThis.__fullPageShot.call(m, a)
        : { ok: false, error: 'The page was reloaded during the capture.' }),
      args: [method, args],
    });
    const out = res && res.result;
    if (!out) throw new Error('The page was closed or navigated away during the capture.');
    if (!out.ok) throw new Error(out.error);
    return out.value;
  };

  await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });

  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await pruneOldCaptures();

  const frames = [];
  let truncated = false;
  let info;

  try {
    info = await call('begin');
    // Step by the visible size of the scrolled area as it is *now* (it can
    // change between frames), minus a small overlap.
    const step = (size) => Math.max(1, Math.floor(size) - OVERLAP_PX);

    // Scroll to (x, y), then capture. Returns null when `accept` rejects the
    // position the page actually ended up at.
    const shoot = async (x, y, accept) => {
      for (let attempt = 0; ; attempt++) {
        const pos = await call('moveTo', x, y);
        if (Math.abs(pos.vw - info.vw) > 0.5 || Math.abs(pos.vh - info.vh) > 0.5) {
          throw new Error('The window was resized during the capture. Please try again.');
        }
        if (!accept(pos)) return null;
        const blob = await grab(tabId);
        const after = await call('measure');
        // If the page moved while the frame was being taken, take it again.
        const moved = Math.abs(after.x - pos.x) > 0.6 || Math.abs(after.y - pos.y) > 0.6;
        if (!moved || attempt >= 2) {
          await ShotDB.put(`${id}:frame:${frames.length}`, blob);
          frames.push({ x: pos.x, y: pos.y, crop: pos.crop });
          return after;
        }
      }
    };

    let y = 0;
    let prevRowY = -Infinity;
    rows: for (;;) {
      let x = 0;
      let rowY = null;
      let last = null;
      for (let col = 0; ; col++) {
        const prevX = last ? last.x : -Infinity;
        const res = await shoot(x, y, (pos) => {
          if (col === 0) return pos.y > prevRowY + 0.5; // no progress: bottom reached
          return pos.x > prevX + 0.5;
        });
        if (!res) {
          if (col === 0) break rows;
          break;
        }
        last = res;
        if (col === 0) rowY = frames[frames.length - 1].y;
        const progress = Math.min(1, (rowY + res.crop.h) / (res.maxY + res.crop.h));
        await quiet(chrome.action.setBadgeText({ tabId, text: Math.floor(progress * 100) + '%' }));

        if (frames.length >= MAX_FRAMES) { truncated = true; break rows; }
        if (job.cancel) break rows;
        if (res.maxX <= 0.5 || res.x >= res.maxX - 0.5) break;
        x = Math.min(res.x + step(res.crop.w), res.maxX);
      }
      // Page height is re-read every row, so pages that grow while being
      // scrolled (lazy loading) are followed to their real end.
      if (rowY >= last.maxY - 0.5) break;
      prevRowY = rowY;
      y = Math.min(rowY + step(last.crop.h), last.maxY);
    }
  } catch (err) {
    await quiet(ShotDB.delPrefix(id + ':'));
    throw err;
  } finally {
    await quiet(call('end'));
  }

  if (!frames.length) {
    await quiet(ShotDB.delPrefix(id + ':'));
    throw new Error('Nothing could be captured on this page.');
  }

  await ShotDB.put(`${id}:meta`, {
    id,
    createdAt: Date.now(),
    url: info.url,
    title: info.title,
    dpr: info.dpr,
    vw: info.vw,
    vvw: info.vvw,
    vh: info.vh,
    isRoot: info.isRoot,
    background: info.background,
    frames,
    stopped: job.cancel,
    truncated,
    tiles: null,
  });
  return id;
}

// One viewport capture, respecting Chrome's rate limit and making sure the
// tab being captured is really the one on screen.
async function grab(tabId) {
  const mustBeActive = async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      throw new Error('The tab has to stay in front while it is being captured. Please try again and keep the tab open until it finishes.');
    }
    return tab;
  };
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const tab = await mustBeActive();
    let dataUrl;
    try {
      lastCaptureAt = Date.now();
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err && err.message)) && attempt < 6) {
        await sleep(700);
        continue;
      }
      throw err;
    }
    await mustBeActive();
    if (!dataUrl) throw new Error('The browser returned an empty capture.');
    return (await fetch(dataUrl)).blob();
  }
}

async function pruneOldCaptures() {
  try {
    const ids = [...new Set((await ShotDB.keys()).map((k) => String(k).split(':')[0]))];
    ids.sort((a, b) => parseInt(b, 36) - parseInt(a, 36)); // newest first
    for (const old of ids.slice(KEEP_CAPTURES - 1)) await ShotDB.delPrefix(old + ':');
  } catch (_) { /* best effort */ }
}
