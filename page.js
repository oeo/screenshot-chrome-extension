// Injected into the page (isolated world) when a capture starts. Exposes a
// small controller the service worker drives step by step:
//
//   begin()        prepare the page, pick what to scroll, return measurements
//   moveTo(x, y)   scroll, let the page settle, return the *actual* position
//   measure()      current position / sizes (used to verify a frame)
//   end()          undo every change made to the page
(() => {
  'use strict';
  if (globalThis.__fullPageShot) return;

  const STYLE_ID = '__full-page-shot-style__';
  const SCROLL_KEYS = new Set([
    ' ', 'PageUp', 'PageDown', 'Home', 'End',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ]);

  let S = null; // state of the running capture

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // requestAnimationFrame never fires in a hidden tab; never hang on it.
  const frame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 120);
  });

  // ---------------------------------------------------------------- styles

  function override(el, prop, value) {
    let rec = S.overrides.get(el);
    if (!rec) {
      // Remember the style attribute exactly as written so it can be put
      // back byte-for-byte (el.style edits re-serialize the attribute).
      rec = { attr: el.getAttribute('style'), cssText: el.style.cssText, props: new Map() };
      S.overrides.set(el, rec);
    }
    if (!rec.props.has(prop)) {
      rec.props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    }
    el.style.setProperty(prop, value, 'important');
  }

  function restoreProp(el, prop) {
    const rec = S.overrides.get(el);
    if (!rec || !rec.props.has(prop)) return;
    const [value, priority] = rec.props.get(prop);
    rec.props.delete(prop);
    try {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
      if (!rec.props.size) {
        if (el.style.cssText === rec.cssText) {
          // Reading the attribute first flushes Chrome's lazily serialized
          // style; without it an empty style="" would reappear afterwards.
          el.getAttribute('style');
          if (rec.attr === null) el.removeAttribute('style');
          else el.setAttribute('style', rec.attr);
        }
        S.overrides.delete(el);
      }
    } catch (_) { /* element may be gone */ }
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html, body {
        scroll-behavior: auto !important;
        scroll-snap-type: none !important;
      }
      html { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }`;
    (document.head || document.documentElement).appendChild(style);
    S.style = style;
  }

  // ------------------------------------------------------------ DOM helpers

  const shadowOf = (el) => {
    try {
      if (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (_) { /* fall through */ }
    return el.shadowRoot;
  };

  function* allElements(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      yield node;
      const shadow = shadowOf(node);
      if (shadow) yield* allElements(shadow);
    }
  }

  const parentOf = (el) => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root && root.host ? root.host : null;
  };

  const isRootEl = (el) => el === document.documentElement || el === document.body;

  // ------------------------------------------------------- scroller choice

  function rootAllowsHorizontal() {
    const bad = (v) => v === 'hidden' || v === 'clip';
    const html = getComputedStyle(document.documentElement).overflowX;
    if (html !== 'visible') return !bad(html);
    // html's overflow is "visible": the body's value propagates to the viewport.
    if (document.body) return !bad(getComputedStyle(document.body).overflowX);
    return true;
  }

  function pickScroller() {
    const root = document.scrollingElement || document.documentElement;
    const rootMaxY = Math.max(0, root.scrollHeight - root.clientHeight);
    const rootMaxX = Math.max(0, root.scrollWidth - root.clientWidth);
    const hRoot = rootMaxX > 1 && rootAllowsHorizontal();
    const vw = window.innerWidth, vh = window.innerHeight;

    // Dominant scrollable container on screen ("app shell" layouts, where
    // the document itself does not scroll, or only by a stray few pixels).
    let best = null, bestArea = 0;
    for (const el of allElements(document)) {
      if (el === root || el.scrollHeight - el.clientHeight <= 1) continue;
      const cs = getComputedStyle(el);
      if (!/^(auto|scroll|overlay)$/.test(cs.overflowY)) continue;
      if (cs.visibility === 'hidden') continue;
      if (isRootEl(el) && rootMaxY > 1) continue; // body overflow propagated to the viewport
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    const inner = () => {
      const cs = getComputedStyle(best);
      const horizontal = best.scrollWidth - best.clientWidth > 1 &&
        /^(auto|scroll|overlay)$/.test(cs.overflowX);
      return { el: best, isRoot: false, horizontal };
    };
    const rootScrolls = rootMaxY > 1 || hRoot;

    if (best && bestArea >= 0.25 * vw * vh) {
      if (!rootScrolls) return inner();
      // The document scrolls a little (stray margins) but the real content
      // lives in a large inner container: that container is the page.
      const innerMaxY = best.scrollHeight - best.clientHeight;
      if (!hRoot && rootMaxY < 0.5 * vh && bestArea >= 0.5 * vw * vh && innerMaxY > 4 * rootMaxY) {
        return inner();
      }
    }
    return { el: root, isRoot: true, horizontal: hRoot };
  }

  // ------------------------------------------------------------ measuring

  function cropRect() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (S.isRoot) return { x: 0, y: 0, w: vw, h: vh };
    const el = S.scroller;
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left + el.clientLeft);
    const top = Math.max(0, r.top + el.clientTop);
    const right = Math.min(vw, r.left + el.clientLeft + el.clientWidth);
    const bottom = Math.min(vh, r.top + el.clientTop + el.clientHeight);
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }

  // In "inner scroller" mode the document itself may still scroll a little
  // (stray margins). Vertical positions are then the sum of both scroll
  // offsets: the inner element is scrolled first, the document last, so
  // nothing at the very bottom is left off-screen.
  const outerRoot = () => (S.isRoot ? null : (document.scrollingElement || document.documentElement));

  function measure() {
    const el = S.scroller;
    const outer = outerRoot();
    const outerY = outer ? outer.scrollTop : 0;
    const outerMaxY = outer ? Math.max(0, outer.scrollHeight - outer.clientHeight) : 0;
    return {
      x: el.scrollLeft,
      y: el.scrollTop + outerY,
      maxX: S.horizontal ? Math.max(0, el.scrollWidth - el.clientWidth) : 0,
      maxY: Math.max(0, el.scrollHeight - el.clientHeight) + outerMaxY,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio,
      // Fractional viewport width (innerWidth is rounded to whole pixels).
      vvw: window.visualViewport ? window.visualViewport.width * window.visualViewport.scale : window.innerWidth,
      crop: cropRect(),
    };
  }

  // --------------------------------------------- fixed / sticky handling

  // Does this sticky element stick relative to the thing we are scrolling?
  function sticksToScroller(el) {
    for (let p = parentOf(el); p; p = parentOf(p)) {
      if (p === S.scroller) return true;
      if (S.isRoot && isRootEl(p)) return true;
      const cs = getComputedStyle(p);
      const scrolls = (v) => v !== 'visible' && v !== 'clip';
      if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) return false;
    }
    return S.isRoot;
  }

  // position:fixed is only viewport-fixed when no ancestor establishes a
  // containing block for it (transform, filter, containment...). Otherwise
  // it scrolls with the content and must be left alone.
  function isViewportFixed(el) {
    for (let p = parentOf(el); p; p = parentOf(p)) {
      const cs = getComputedStyle(p);
      if (cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none') return false;
      if (cs.backdropFilter && cs.backdropFilter !== 'none') return false;
      if (cs.containerType && cs.containerType !== 'normal') return false;
      if (/paint|layout|strict|content/.test(cs.contain || '')) return false;
      if (/transform|perspective|filter/.test(cs.willChange || '')) return false;
    }
    return true;
  }

  // Sticky elements are un-stuck (they then sit at their natural place in
  // the page). Viewport-fixed bars are shown once: top ones at the very top
  // of the page, bottom ones at the very bottom - never repeated mid-page.
  function adjustPinnedElements() {
    const m = measure();
    const atTop = m.y <= 1;
    const atBottom = m.y >= m.maxY - 1;
    const crop = m.crop;

    for (const el of allElements(document)) {
      const cs = getComputedStyle(el);
      const position = cs.position;

      if (position === 'sticky') {
        if (!S.sticky.has(el)) {
          S.sticky.add(el);
          if (sticksToScroller(el)) {
            override(el, 'top', 'auto');
            override(el, 'bottom', 'auto');
            if (S.horizontal) {
              override(el, 'left', 'auto');
              override(el, 'right', 'auto');
            }
          }
        }
        continue;
      }

      const hiddenByUs = S.hidden.has(el);
      if (position !== 'fixed') {
        if (hiddenByUs) { restoreProp(el, 'opacity'); S.hidden.delete(el); }
        continue;
      }

      let hide = false;
      if (!(atTop && atBottom)) {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' &&
          (hiddenByUs || Number(cs.opacity) !== 0);
        if (visible && r.height < 0.7 * crop.h) {
          // Only elements that sit (mostly) over the scrolled area matter.
          const ix = Math.min(r.right, crop.x + crop.w) - Math.max(r.left, crop.x);
          const iy = Math.min(r.bottom, crop.y + crop.h) - Math.max(r.top, crop.y);
          const inside = ix > 0 && iy > 0 ? (ix * iy) / (r.width * r.height) : 0;
          if (inside >= 0.5 && isViewportFixed(el)) {
            const isTop = r.top + r.height / 2 < crop.y + crop.h / 2;
            hide = isTop ? !atTop : !atBottom;
          }
        }
      }
      if (hide && !hiddenByUs) { override(el, 'opacity', '0'); S.hidden.add(el); }
      else if (!hide && hiddenByUs) { restoreProp(el, 'opacity'); S.hidden.delete(el); }
    }
  }

  // ------------------------------------------------------------- settling

  async function waitForImages(timeout) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const pending = () => {
      for (const img of document.images) {
        if (img.complete || !(img.currentSrc || img.src)) continue;
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) {
          return true;
        }
      }
      return false;
    };
    const deadline = Date.now() + timeout;
    while (pending() && Date.now() < deadline) await sleep(50);
  }

  function scrollNow(x, y) {
    const el = S.scroller;
    const outer = outerRoot();
    if (!outer) {
      el.scrollTo({ left: x, top: y, behavior: 'instant' });
      return;
    }
    const innerMax = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTo({ left: x, top: Math.min(y, innerMax), behavior: 'instant' });
    // Whatever the inner element could not absorb goes to the document.
    const rest = Math.max(0, y - el.scrollTop);
    outer.scrollTo({ left: 0, top: rest < 0.5 ? 0 : rest, behavior: 'instant' });
  }

  // Quick pass over the page so lazy-loaded content starts loading and the
  // page height settles before the first frame is taken.
  async function warmUp() {
    const start = measure();
    const limit = start.maxY;
    const deadline = Date.now() + 8000;
    let y = 0, last = -1;
    scrollNow(0, 0);
    await frame();
    while (y < limit - 0.5 && Date.now() < deadline) {
      y = Math.min(y + Math.max(50, start.crop.h), limit);
      scrollNow(0, y);
      await frame();
      await sleep(40);
      const actual = measure().y;
      if (actual <= last + 0.5) break;
      last = actual;
    }
    if (limit > 0.5) await sleep(150);
  }

  // ---------------------------------------------------------------- input

  function blockInput(e) {
    if (e.type === 'keydown') {
      if (e.key === 'Escape') {
        try { chrome.runtime.sendMessage({ type: 'full-page-shot:cancel' }).catch(() => {}); } catch (_) {}
      } else if (!SCROLL_KEYS.has(e.key)) {
        return;
      }
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  const INPUT_EVENTS = ['wheel', 'touchmove', 'keydown'];
  const INPUT_OPTS = { capture: true, passive: false };

  // ------------------------------------------------------------------ API

  async function begin() {
    if (S) throw new Error('A capture is already running on this page.');
    S = {
      overrides: new Map(),
      sticky: new WeakSet(),
      hidden: new Set(),
      style: null,
      scroller: null,
      isRoot: true,
      horizontal: false,
      orig: null,
      rootOrig: null,
    };
    try {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, sleep(3000)]);
      }
      for (const type of INPUT_EVENTS) window.addEventListener(type, blockInput, INPUT_OPTS);
      injectStyle();
      await frame();

      const pick = pickScroller();
      S.scroller = pick.el;
      S.isRoot = pick.isRoot;
      S.horizontal = pick.horizontal;
      S.orig = { x: pick.el.scrollLeft, y: pick.el.scrollTop };
      if (!pick.isRoot) {
        const root = document.scrollingElement || document.documentElement;
        S.rootOrig = { el: root, x: root.scrollLeft, y: root.scrollTop };
        override(pick.el, 'scroll-behavior', 'auto');
        override(pick.el, 'scroll-snap-type', 'none');
        override(pick.el, 'scrollbar-width', 'none');
      }
      await frame();
      await warmUp();

      const bg = (el) => {
        if (!el) return null;
        const c = getComputedStyle(el).backgroundColor;
        return c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c) ? c : null;
      };
      return {
        ...measure(),
        isRoot: S.isRoot,
        horizontal: S.horizontal,
        background: bg(document.documentElement) || bg(document.body) || '#ffffff',
        url: location.href,
        title: document.title,
      };
    } catch (err) {
      end();
      throw err;
    }
  }

  async function moveTo(x, y) {
    if (!S) throw new Error('The page was reloaded during the capture.');
    scrollNow(x, y);
    await frame();
    await sleep(120); // let the page's own scroll handlers react
    adjustPinnedElements();
    await frame();
    await waitForImages(1500);
    await frame();
    await frame();
    return measure();
  }

  function end() {
    if (!S) return;
    const s = S;
    for (const type of INPUT_EVENTS) window.removeEventListener(type, blockInput, INPUT_OPTS);
    for (const el of [...s.overrides.keys()]) {
      for (const prop of [...s.overrides.get(el).props.keys()]) restoreProp(el, prop);
    }
    if (s.orig && s.scroller) {
      try { s.scroller.scrollTo({ left: s.orig.x, top: s.orig.y, behavior: 'instant' }); } catch (_) {}
    }
    if (s.rootOrig) {
      try { s.rootOrig.el.scrollTo({ left: s.rootOrig.x, top: s.rootOrig.y, behavior: 'instant' }); } catch (_) {}
    }
    if (s.style) s.style.remove();
    S = null;
  }

  const api = {
    begin,
    moveTo,
    measure: () => {
      if (!S) throw new Error('The page was reloaded during the capture.');
      return measure();
    },
    end,
  };

  globalThis.__fullPageShot = {
    async call(method, args) {
      try {
        return { ok: true, value: await api[method](...(args || [])) };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
  };
})();
