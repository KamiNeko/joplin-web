(() => {
  'use strict';

  // Idempotent guard: reuse existing controller if overlay.js is injected again
  if (globalThis.__joplinClipperOverlay && typeof globalThis.__joplinClipperOverlay.activate === 'function') {
    return;
  }

  const HOST_ID = 'joplin-clipper-overlay-host';
  const SNAP_OVERLAP_THRESHOLD = 0.6;
  const MIN_CROP_SIZE = 16;
  const EDGE_SCROLL_MARGIN = 48;
  const EDGE_SCROLL_MAX_SPEED = 22;

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'LINK',
    'META',
    'HEAD',
    'BR',
    'HR',
    'FORM',
    'BUTTON',
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'IFRAME',
    'OBJECT',
    'EMBED',
  ]);

  const NON_VISUAL_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'LINK',
    'META',
    'HEAD',
    'BR',
    'HR',
  ]);

  const BLOCK_TAGS = new Set([
    'ARTICLE',
    'SECTION',
    'MAIN',
    'DIV',
    'P',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'UL',
    'OL',
    'LI',
    'DL',
    'DT',
    'DD',
    'BLOCKQUOTE',
    'PRE',
    'FIGURE',
    'FIGCAPTION',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'HEADER',
    'FOOTER',
    'ASIDE',
    'ADDRESS',
    'DETAILS',
    'SUMMARY',
    'IMG',
    'PICTURE',
    'VIDEO',
    'CANVAS',
  ]);

  const BLOCK_DISPLAYS = new Set(['block', 'flex', 'grid', 'table', 'list-item', 'flow-root']);

  const OVERLAY_CSS = `
    :host {
      all: initial !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      overflow: visible !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    .hidden {
      display: none !important;
    }

    .dim-slab {
      position: fixed;
      background: rgba(15, 23, 42, 0.48);
      pointer-events: none;
      z-index: 1;
    }

    .hover-box {
      position: fixed;
      border: 2px dashed #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      border-radius: 3px;
      pointer-events: none;
      z-index: 2;
    }

    .selection-rects {
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 2;
    }

    .sel-rect {
      position: fixed;
      background: rgba(37, 99, 235, 0.18);
      border: 1.5px solid #2563eb;
      border-radius: 2px;
      pointer-events: none;
    }

    .box {
      position: fixed;
      border: 2px solid #2563eb;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85), 0 6px 24px rgba(15, 23, 42, 0.24);
      border-radius: 3px;
      pointer-events: none;
      z-index: 3;
    }

    .box.dragging {
      border-style: dashed;
      background: rgba(37, 99, 235, 0.06);
    }

    .toolbar {
      position: absolute;
      left: -2px;
      top: -34px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px 4px 9px;
      border-radius: 7px;
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      pointer-events: auto;
      user-select: none;
      z-index: 10;
    }

    .toolbar.inside-top {
      top: 8px;
      left: 8px;
    }

    .badge-label {
      letter-spacing: 0.01em;
      padding-right: 4px;
    }

    .tb-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: rgba(255, 255, 255, 0.1);
      color: #f8fafc;
      border-radius: 5px;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
      transition: background 0.12s ease, border-color 0.12s ease;
    }

    .tb-btn:hover {
      background: rgba(255, 255, 255, 0.22);
      border-color: rgba(255, 255, 255, 0.42);
    }

    .tb-btn:active {
      background: rgba(37, 99, 235, 0.65);
    }

    .tb-reset {
      font-size: 11px;
      font-weight: 600;
      padding: 0 7px;
    }

    .handle {
      position: absolute;
      pointer-events: auto;
      user-select: none;
      touch-action: none;
      z-index: 6;
    }

    /* Edge hit zones (keep >= 10px inside box so handles remain grabbable at viewport edges) */
    .handle-n {
      top: -6px;
      left: 14px;
      right: 14px;
      height: 16px;
      cursor: ns-resize;
    }
    .handle-s {
      bottom: -6px;
      left: 14px;
      right: 14px;
      height: 16px;
      cursor: ns-resize;
    }
    .handle-w {
      left: -6px;
      top: 14px;
      bottom: 14px;
      width: 16px;
      cursor: ew-resize;
    }
    .handle-e {
      right: -6px;
      top: 14px;
      bottom: 14px;
      width: 16px;
      cursor: ew-resize;
    }

    .handle-n::before,
    .handle-s::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 34px;
      height: 8px;
      border-radius: 999px;
      background: #ffffff;
      border: 2px solid #2563eb;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.35);
    }

    .handle-w::before,
    .handle-e::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 8px;
      height: 34px;
      border-radius: 999px;
      background: #ffffff;
      border: 2px solid #2563eb;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.35);
    }

    /* Corner handles */
    .handle-nw,
    .handle-ne,
    .handle-sw,
    .handle-se {
      width: 20px;
      height: 20px;
      z-index: 7;
    }

    .handle-nw { top: -6px; left: -6px; cursor: nwse-resize; }
    .handle-ne { top: -6px; right: -6px; cursor: nesw-resize; }
    .handle-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
    .handle-se { bottom: -6px; right: -6px; cursor: nwse-resize; }

    .handle-nw::before,
    .handle-ne::before,
    .handle-sw::before,
    .handle-se::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ffffff;
      border: 2.5px solid #2563eb;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.38);
    }

    .handle:hover::before {
      background: #dbeafe;
      transform: translate(-50%, -50%) scale(1.12);
    }
  `;

  function getLib() {
    return globalThis.__joplinClipperLib || null;
  }

  function isHidden(el) {
    const lib = getLib();
    if (lib && typeof lib.isLiveElementHidden === 'function') {
      return lib.isLiveElementHidden(el);
    }
    if (!el || el.nodeType !== 1 || el.id === HOST_ID) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    try {
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return true;
    } catch {
      // ignore
    }
    return false;
  }

  function isCandidateBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (el.id === HOST_ID || el.closest(`#${HOST_ID}`)) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (isHidden(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    if (BLOCK_TAGS.has(el.tagName)) return true;
    try {
      const display = window.getComputedStyle(el).display;
      if (BLOCK_DISPLAYS.has(display)) return true;
      if (display === 'inline-block' && rect.width >= 24 && rect.height >= 16) return true;
    } catch {
      // ignore
    }
    return false;
  }

  function resolvePickTarget(rawEl) {
    let cur = rawEl;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.id === HOST_ID) return null;
      if (isCandidateBlock(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function computeUnionRect(elements) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of elements || []) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!Number.isFinite(left)) return null;
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function overlapRatio(elRect, dragRect) {
    const ix = Math.max(0, Math.min(elRect.right, dragRect.right) - Math.max(elRect.left, dragRect.left));
    const iy = Math.max(0, Math.min(elRect.bottom, dragRect.bottom) - Math.max(elRect.top, dragRect.top));
    const area = elRect.width * elRect.height;
    return area > 0 ? (ix * iy) / area : 0;
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function hasMeaningfulVisualContent(el) {
    if (!el || isHidden(el)) return false;
    if (NON_VISUAL_TAGS.has(el.tagName)) return false;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS' || el.tagName === 'FORM') {
      return true;
    }
    if ((el.textContent || '').trim().length > 0) return true;
    if (el.querySelector('img, video, canvas, svg')) return true;
    return false;
  }

  function getVisibleCandidateChildren(el) {
    const out = [];
    for (const child of Array.from(el.children)) {
      if (isCandidateBlock(child)) {
        out.push(child);
      }
    }
    return out;
  }

  function hasVisibleChildOutside(container, dragRect) {
    for (const child of Array.from(container.children)) {
      if (NON_VISUAL_TAGS.has(child.tagName) || isHidden(child)) continue;
      const r = child.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (!hasMeaningfulVisualContent(child)) continue;
      if (overlapRatio(r, dragRect) < SNAP_OVERLAP_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  function collectSnappedBlocks(container, dragRect, out) {
    for (const child of Array.from(container.children)) {
      if (child.id === HOST_ID || NON_VISUAL_TAGS.has(child.tagName) || isHidden(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (!rectsOverlap(rect, dragRect)) continue;

      if (isCandidateBlock(child)) {
        const ratio = overlapRatio(rect, dragRect);
        const blockChildren = getVisibleCandidateChildren(child);
        if (blockChildren.length === 0) {
          if (ratio >= SNAP_OVERLAP_THRESHOLD) {
            out.push(child);
          }
        } else if (ratio >= SNAP_OVERLAP_THRESHOLD && !hasVisibleChildOutside(child, dragRect)) {
          out.push(child);
        } else {
          collectSnappedBlocks(child, dragRect, out);
        }
      } else if (!SKIP_TAGS.has(child.tagName)) {
        collectSnappedBlocks(child, dragRect, out);
      }
    }
  }

  function snapRectToElements(dragRect, fallbackElements) {
    const lib = getLib();
    const collected = [];
    if (document.body) {
      collectSnappedBlocks(document.body, dragRect, collected);
    }
    const deduped =
      lib && typeof lib.dedupeTopMostInDocumentOrder === 'function'
        ? lib.dedupeTopMostInDocumentOrder(collected)
        : collected;
    if (deduped.length > 0) return deduped;

    // Fallback: pick candidate block at center of dragged rectangle
    const cx = Math.min(window.innerWidth - 1, Math.max(0, (dragRect.left + dragRect.right) / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, (dragRect.top + dragRect.bottom) / 2));
    const hit = resolvePickTarget(document.elementFromPoint(cx, cy));
    if (hit) return [hit];
    return fallbackElements || [];
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function setBoxStyle(el, left, top, width, height) {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.max(0, Math.round(width))}px`;
    el.style.height = `${Math.max(0, Math.round(height))}px`;
  }

  function createOverlayController() {
    let mode = 'off';
    let host = null;
    let shadow = null;
    let ui = null;

    let initialArticleElements = [];
    let initialArticleSummary = { words: 0, images: 0 };
    let initialArticleMeta = {};
    let selectedElements = [];
    let adjusted = false;
    let lastSummary = { words: 0, images: 0 };

    // Screenshot mode crop rect in viewport CSS pixels
    let cropRect = { x: 0, y: 0, width: 0, height: 0 };

    // Drag state
    let dragState = null;
    let autoScrollRaf = 0;
    let renderRaf = 0;
    let lastDragEndTime = 0;
    let listenersAttached = false;

    function buildDom() {
      const existing = document.getElementById(HOST_ID);
      if (existing) existing.remove();

      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.position = 'fixed';
      host.style.top = '0';
      host.style.left = '0';
      host.style.width = '0';
      host.style.height = '0';
      host.style.overflow = 'visible';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';

      shadow = host.attachShadow({ mode: 'open' });

      // Constructable stylesheet: works under strict CSP (default-src 'none'; style-src 'self')
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];

      const dimTop = document.createElement('div');
      dimTop.className = 'dim-slab dim-top';
      const dimBottom = document.createElement('div');
      dimBottom.className = 'dim-slab dim-bottom';
      const dimLeft = document.createElement('div');
      dimLeft.className = 'dim-slab dim-left';
      const dimRight = document.createElement('div');
      dimRight.className = 'dim-slab dim-right';

      const hoverBox = document.createElement('div');
      hoverBox.className = 'hover-box hidden';

      const selRects = document.createElement('div');
      selRects.className = 'selection-rects hidden';

      const box = document.createElement('div');
      box.className = 'box';

      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';

      const badgeLabel = document.createElement('span');
      badgeLabel.className = 'badge-label';
      badgeLabel.textContent = 'Article';

      const shrinkBtn = document.createElement('button');
      shrinkBtn.type = 'button';
      shrinkBtn.className = 'tb-btn';
      shrinkBtn.dataset.action = 'shrink';
      shrinkBtn.title = 'Shrink selection (↓)';
      shrinkBtn.setAttribute('aria-label', 'Shrink selection');
      shrinkBtn.textContent = '−';

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'tb-btn';
      expandBtn.dataset.action = 'expand';
      expandBtn.title = 'Expand selection (↑)';
      expandBtn.setAttribute('aria-label', 'Expand selection');
      expandBtn.textContent = '+';

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'tb-btn tb-reset hidden';
      resetBtn.dataset.action = 'reset';
      resetBtn.title = 'Reset (Esc)';
      resetBtn.setAttribute('aria-label', 'Reset selection');
      resetBtn.textContent = 'Reset';

      toolbar.append(badgeLabel, shrinkBtn, expandBtn, resetBtn);
      box.appendChild(toolbar);

      const handleNames = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
      const handles = {};
      for (const name of handleNames) {
        const h = document.createElement('div');
        h.className = `handle handle-${name}`;
        h.dataset.handle = name;
        box.appendChild(h);
        handles[name] = h;
      }

      shadow.append(dimTop, dimBottom, dimLeft, dimRight, hoverBox, selRects, box);
      document.documentElement.appendChild(host);

      ui = {
        dimTop,
        dimBottom,
        dimLeft,
        dimRight,
        hoverBox,
        selRects,
        box,
        toolbar,
        badgeLabel,
        shrinkBtn,
        expandBtn,
        resetBtn,
        handles,
      };

      shrinkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        shrinkSelection();
      });

      expandBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        expandSelection();
      });

      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetSelection();
      });

      for (const name of handleNames) {
        handles[name].addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startHandleDrag(name, e);
        });
      }
    }

    function updateDimSlabs(rect) {
      if (!ui) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        ui.dimTop.classList.add('hidden');
        ui.dimBottom.classList.add('hidden');
        ui.dimLeft.classList.add('hidden');
        ui.dimRight.classList.add('hidden');
        return;
      }

      const l = clamp(rect.left, 0, vw);
      const t = clamp(rect.top, 0, vh);
      const r = clamp(rect.right, 0, vw);
      const b = clamp(rect.bottom, 0, vh);

      ui.dimTop.classList.remove('hidden');
      ui.dimBottom.classList.remove('hidden');
      ui.dimLeft.classList.remove('hidden');
      ui.dimRight.classList.remove('hidden');

      setBoxStyle(ui.dimTop, 0, 0, vw, t);
      setBoxStyle(ui.dimBottom, 0, b, vw, vh - b);
      setBoxStyle(ui.dimLeft, 0, t, l, b - t);
      setBoxStyle(ui.dimRight, r, t, vw - r, b - t);
    }

    function positionToolbar(rect) {
      if (!ui || !rect) return;
      const inside = rect.top < 38;
      ui.toolbar.classList.toggle('inside-top', inside);
    }

    function getCurrentViewportRect() {
      if (mode === 'article') {
        if (dragState && dragState.kind === 'article-handle') {
          return {
            left: dragState.docLeft - window.scrollX,
            top: dragState.docTop - window.scrollY,
            right: dragState.docRight - window.scrollX,
            bottom: dragState.docBottom - window.scrollY,
            width: Math.max(0, dragState.docRight - dragState.docLeft),
            height: Math.max(0, dragState.docBottom - dragState.docTop),
          };
        }
        return computeUnionRect(selectedElements);
      }
      if (mode === 'screenshot') {
        return {
          left: cropRect.x,
          top: cropRect.y,
          right: cropRect.x + cropRect.width,
          bottom: cropRect.y + cropRect.height,
          width: cropRect.width,
          height: cropRect.height,
        };
      }
      return null;
    }

    function renderSelectionMode() {
      if (!ui) return;
      ui.box.classList.add('hidden');
      ui.hoverBox.classList.add('hidden');
      ui.dimTop.classList.add('hidden');
      ui.dimBottom.classList.add('hidden');
      ui.dimLeft.classList.add('hidden');
      ui.dimRight.classList.add('hidden');
      ui.selRects.classList.remove('hidden');
      ui.selRects.innerHTML = '';

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return;
      for (let i = 0; i < sel.rangeCount; i++) {
        const rects = Array.from(sel.getRangeAt(i).getClientRects());
        for (const r of rects) {
          if (r.width < 1 || r.height < 1) continue;
          const div = document.createElement('div');
          div.className = 'sel-rect';
          setBoxStyle(div, r.left, r.top, r.width, r.height);
          ui.selRects.appendChild(div);
        }
      }
    }

    function render() {
      if (!ui || mode === 'off') return;
      if (mode === 'selection') {
        renderSelectionMode();
        return;
      }

      ui.selRects.classList.add('hidden');
      const rect = getCurrentViewportRect();
      if (!rect || rect.width < 1 || rect.height < 1) {
        ui.box.classList.add('hidden');
        updateDimSlabs(null);
        return;
      }

      ui.box.classList.remove('hidden');
      ui.box.classList.toggle('dragging', Boolean(dragState));
      setBoxStyle(ui.box, rect.left, rect.top, rect.width, rect.height);
      updateDimSlabs(rect);
      positionToolbar(rect);

      if (mode === 'article') {
        ui.badgeLabel.textContent = adjusted ? 'Article (adjusted)' : 'Article';
        ui.shrinkBtn.classList.remove('hidden');
        ui.expandBtn.classList.remove('hidden');
        ui.resetBtn.classList.toggle('hidden', !adjusted);
      } else if (mode === 'screenshot') {
        const w = Math.round(cropRect.width);
        const h = Math.round(cropRect.height);
        ui.badgeLabel.textContent = `Screenshot · ${w} × ${h}`;
        ui.shrinkBtn.classList.add('hidden');
        ui.expandBtn.classList.add('hidden');
        ui.resetBtn.classList.toggle('hidden', !adjusted);
      }
    }

    function scheduleRender() {
      if (renderRaf) return;
      renderRaf = window.requestAnimationFrame(() => {
        renderRaf = 0;
        render();
      });
    }

    function buildStatePayload() {
      const dpr = window.devicePixelRatio || 1;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (mode === 'article') {
        const rect = computeUnionRect(selectedElements);
        return {
          mode: 'article',
          words: lastSummary.words,
          images: lastSummary.images,
          adjusted,
          elementCount: selectedElements.length,
          rect: rect
            ? {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              }
            : null,
          viewport,
          dpr,
        };
      }
      if (mode === 'screenshot') {
        return {
          mode: 'screenshot',
          adjusted,
          cropRect: {
            x: Math.round(cropRect.x),
            y: Math.round(cropRect.y),
            width: Math.round(cropRect.width),
            height: Math.round(cropRect.height),
          },
          viewport,
          dpr,
        };
      }
      if (mode === 'selection') {
        const lib = getLib();
        const selSummary =
          lib && typeof lib.summarizeSelection === 'function'
            ? lib.summarizeSelection()
            : { hasSelection: false, words: 0, images: 0 };
        return {
          mode: 'selection',
          hasSelection: selSummary.hasSelection,
          words: selSummary.words,
          images: selSummary.images,
          adjusted: false,
          viewport,
          dpr,
        };
      }
      return { mode: 'off', adjusted: false, viewport, dpr };
    }

    function notifyPanel() {
      const payload = buildStatePayload();
      try {
        chrome.runtime.sendMessage({ type: 'OVERLAY_STATE', state: payload }).catch(() => {});
      } catch {
        // ignore if extension context reloaded
      }
    }

    function setSelectedElements(elements, isAdjusted) {
      const lib = getLib();
      const cleaned =
        lib && typeof lib.dedupeTopMostInDocumentOrder === 'function'
          ? lib.dedupeTopMostInDocumentOrder(elements)
          : elements.filter((el) => el && el.isConnected);
      if (cleaned.length === 0) return;

      selectedElements = cleaned;
      adjusted = Boolean(isAdjusted);
      if (!adjusted) {
        lastSummary = { ...initialArticleSummary };
      } else if (lib && typeof lib.summarizeLiveElements === 'function') {
        lastSummary = lib.summarizeLiveElements(selectedElements);
      }
      render();
      notifyPanel();
    }

    function expandSelection() {
      if (mode !== 'article' || selectedElements.length === 0) return;
      const lib = getLib();
      if (selectedElements.length === 1) {
        const parent = selectedElements[0].parentElement;
        if (parent && parent !== document.documentElement) {
          setSelectedElements([parent], true);
        }
        return;
      }
      const lca = lib && typeof lib.lowestCommonAncestor === 'function'
        ? lib.lowestCommonAncestor(selectedElements)
        : null;
      if (!lca || lca === document.documentElement) return;
      if (selectedElements.includes(lca)) {
        if (lca.parentElement && lca.parentElement !== document.documentElement) {
          setSelectedElements([lca.parentElement], true);
        }
      } else {
        setSelectedElements([lca], true);
      }
    }

    function shrinkSelection() {
      if (mode !== 'article' || selectedElements.length === 0) return;
      if (selectedElements.length > 1) {
        let best = null;
        let bestArea = -1;
        for (const el of selectedElements) {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            best = el;
          }
        }
        if (best) setSelectedElements([best], true);
        return;
      }

      const current = selectedElements[0];
      let bestChild = null;
      let bestArea = -1;
      for (const child of Array.from(current.children)) {
        if (!isCandidateBlock(child)) continue;
        const r = child.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          bestChild = child;
        }
      }
      if (bestChild) {
        setSelectedElements([bestChild], true);
      }
    }

    function resetSelection() {
      if (mode === 'article') {
        if (initialArticleElements.length > 0) {
          setSelectedElements(initialArticleElements, false);
        }
      } else if (mode === 'screenshot') {
        cropRect = {
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
        adjusted = false;
        render();
        notifyPanel();
      }
    }

    function stopAutoScroll() {
      if (autoScrollRaf) {
        window.cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = 0;
      }
    }

    function applyDragAt(clientX, clientY) {
      if (!dragState) return;
      dragState.lastClientX = clientX;
      dragState.lastClientY = clientY;

      if (dragState.kind === 'article-handle') {
        const docX = clientX + window.scrollX;
        const docY = clientY + window.scrollY;
        const h = dragState.handle;
        let l = dragState.origLeft;
        let t = dragState.origTop;
        let r = dragState.origRight;
        let b = dragState.origBottom;

        if (h.includes('w')) l = Math.min(docX, r - MIN_CROP_SIZE);
        if (h.includes('e')) r = Math.max(docX, l + MIN_CROP_SIZE);
        if (h.includes('n')) t = Math.min(docY, b - MIN_CROP_SIZE);
        if (h.includes('s')) b = Math.max(docY, t + MIN_CROP_SIZE);

        dragState.docLeft = l;
        dragState.docTop = t;
        dragState.docRight = r;
        dragState.docBottom = b;
        render();
        return;
      }

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cx = clamp(clientX, 0, vw);
      const cy = clamp(clientY, 0, vh);

      if (dragState.kind === 'screenshot-handle') {
        const h = dragState.handle;
        let l = dragState.origLeft;
        let t = dragState.origTop;
        let r = dragState.origRight;
        let b = dragState.origBottom;

        if (h.includes('w')) l = clamp(cx, 0, r - MIN_CROP_SIZE);
        if (h.includes('e')) r = clamp(cx, l + MIN_CROP_SIZE, vw);
        if (h.includes('n')) t = clamp(cy, 0, b - MIN_CROP_SIZE);
        if (h.includes('s')) b = clamp(cy, t + MIN_CROP_SIZE, vh);

        cropRect = {
          x: Math.round(l),
          y: Math.round(t),
          width: Math.round(r - l),
          height: Math.round(b - t),
        };
        adjusted =
          cropRect.x > 0 ||
          cropRect.y > 0 ||
          cropRect.width < vw ||
          cropRect.height < vh;
        render();
      } else if (dragState.kind === 'screenshot-draw') {
        const l = Math.min(dragState.startX, cx);
        const t = Math.min(dragState.startY, cy);
        const r = Math.max(dragState.startX, cx);
        const b = Math.max(dragState.startY, cy);
        if (r - l >= 4 || b - t >= 4) {
          dragState.moved = true;
          cropRect = {
            x: Math.round(l),
            y: Math.round(t),
            width: Math.max(MIN_CROP_SIZE, Math.round(r - l)),
            height: Math.max(MIN_CROP_SIZE, Math.round(b - t)),
          };
          adjusted = true;
          render();
        }
      }
    }

    function autoScrollTick() {
      autoScrollRaf = 0;
      if (!dragState || dragState.kind !== 'article-handle') return;

      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const y = dragState.lastClientY;
      const x = dragState.lastClientX;
      let dy = 0;
      let dx = 0;

      if (y < EDGE_SCROLL_MARGIN) {
        const factor = (EDGE_SCROLL_MARGIN - y) / EDGE_SCROLL_MARGIN;
        dy = -Math.ceil(factor * EDGE_SCROLL_MAX_SPEED);
      } else if (y > vh - EDGE_SCROLL_MARGIN) {
        const factor = (y - (vh - EDGE_SCROLL_MARGIN)) / EDGE_SCROLL_MARGIN;
        dy = Math.ceil(factor * EDGE_SCROLL_MAX_SPEED);
      }

      if (x < EDGE_SCROLL_MARGIN) {
        const factor = (EDGE_SCROLL_MARGIN - x) / EDGE_SCROLL_MARGIN;
        dx = -Math.ceil(factor * EDGE_SCROLL_MAX_SPEED);
      } else if (x > vw - EDGE_SCROLL_MARGIN) {
        const factor = (x - (vw - EDGE_SCROLL_MARGIN)) / EDGE_SCROLL_MARGIN;
        dx = Math.ceil(factor * EDGE_SCROLL_MAX_SPEED);
      }

      if (dx !== 0 || dy !== 0) {
        window.scrollBy(dx, dy);
        applyDragAt(dragState.lastClientX, dragState.lastClientY);
        autoScrollRaf = window.requestAnimationFrame(autoScrollTick);
      }
    }

    function maybeStartAutoScroll() {
      if (!dragState || dragState.kind !== 'article-handle' || autoScrollRaf) return;
      const y = dragState.lastClientY;
      const x = dragState.lastClientX;
      if (
        y < EDGE_SCROLL_MARGIN ||
        y > window.innerHeight - EDGE_SCROLL_MARGIN ||
        x < EDGE_SCROLL_MARGIN ||
        x > window.innerWidth - EDGE_SCROLL_MARGIN
      ) {
        autoScrollRaf = window.requestAnimationFrame(autoScrollTick);
      }
    }

    function startHandleDrag(handle, e) {
      if (ui) ui.hoverBox.classList.add('hidden');
      const rect = getCurrentViewportRect();
      if (!rect) return;

      if (mode === 'article') {
        dragState = {
          kind: 'article-handle',
          handle,
          origLeft: rect.left + window.scrollX,
          origTop: rect.top + window.scrollY,
          origRight: rect.right + window.scrollX,
          origBottom: rect.bottom + window.scrollY,
          docLeft: rect.left + window.scrollX,
          docTop: rect.top + window.scrollY,
          docRight: rect.right + window.scrollX,
          docBottom: rect.bottom + window.scrollY,
          lastClientX: e.clientX,
          lastClientY: e.clientY,
        };
      } else if (mode === 'screenshot') {
        dragState = {
          kind: 'screenshot-handle',
          handle,
          origLeft: rect.left,
          origTop: rect.top,
          origRight: rect.right,
          origBottom: rect.bottom,
          lastClientX: e.clientX,
          lastClientY: e.clientY,
        };
      }
      render();
    }

    function finishDrag() {
      if (!dragState) return;
      const finished = dragState;
      dragState = null;
      stopAutoScroll();
      lastDragEndTime = Date.now();

      if (finished.kind === 'article-handle') {
        const viewportRect = {
          left: finished.docLeft - window.scrollX,
          top: finished.docTop - window.scrollY,
          right: finished.docRight - window.scrollX,
          bottom: finished.docBottom - window.scrollY,
        };
        const snapped = snapRectToElements(viewportRect, selectedElements);
        setSelectedElements(snapped, true);
      } else if (finished.kind === 'screenshot-handle' || finished.kind === 'screenshot-draw') {
        render();
        notifyPanel();
      }
    }

    function isEventFromOverlay(e) {
      if (!host) return false;
      if (typeof e.composedPath === 'function') {
        return e.composedPath().includes(host);
      }
      return e.target === host;
    }

    function isOnNativeScrollbar(e) {
      return (
        e.clientX >= document.documentElement.clientWidth ||
        e.clientY >= document.documentElement.clientHeight
      );
    }

    function onPointerDown(e) {
      if (mode !== 'article' && mode !== 'screenshot') return;
      if (!e.isTrusted) return;
      if (isEventFromOverlay(e) || isOnNativeScrollbar(e)) return;
      if (e.button !== 0) return;

      if (mode === 'screenshot') {
        e.preventDefault();
        e.stopPropagation();
        dragState = {
          kind: 'screenshot-draw',
          startX: clamp(e.clientX, 0, window.innerWidth),
          startY: clamp(e.clientY, 0, window.innerHeight),
          lastClientX: e.clientX,
          lastClientY: e.clientY,
          moved: false,
        };
      } else if (mode === 'article') {
        // Stop page handlers without blocking scrollbars
        e.stopPropagation();
      }
    }

    function onPointerMove(e) {
      if (dragState) {
        e.preventDefault();
        e.stopPropagation();
        applyDragAt(e.clientX, e.clientY);
        maybeStartAutoScroll();
        return;
      }
      if (mode !== 'article' || !ui) return;
      if (isEventFromOverlay(e) || isOnNativeScrollbar(e)) {
        ui.hoverBox.classList.add('hidden');
        return;
      }
      const target = resolvePickTarget(document.elementFromPoint(e.clientX, e.clientY));
      if (!target) {
        ui.hoverBox.classList.add('hidden');
        return;
      }
      const r = target.getBoundingClientRect();
      ui.hoverBox.classList.remove('hidden');
      setBoxStyle(ui.hoverBox, r.left, r.top, r.width, r.height);
    }

    function onPointerUp(e) {
      if (!dragState) return;
      e.preventDefault();
      e.stopPropagation();
      finishDrag();
    }

    function onClickCapture(e) {
      if (mode !== 'article' && mode !== 'screenshot') return;
      if (!e.isTrusted) return;
      if (isEventFromOverlay(e) || isOnNativeScrollbar(e)) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (Date.now() - lastDragEndTime < 250) return;
      if (mode === 'article') {
        const raw = document.elementFromPoint(e.clientX, e.clientY) || e.target;
        const target = resolvePickTarget(raw);
        if (target) {
          if (ui) ui.hoverBox.classList.add('hidden');
          setSelectedElements([target], true);
        }
      }
    }

    function onAuxClickCapture(e) {
      if (mode !== 'article' && mode !== 'screenshot') return;
      if (!e.isTrusted) return;
      if (isEventFromOverlay(e) || isOnNativeScrollbar(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    function onKeyDown(e) {
      if (mode !== 'article' && mode !== 'screenshot') return;
      // Page scripts can dispatch synthetic key events into this listener; only real keys count
      if (!e.isTrusted) return;
      const target = e.target;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resetSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        try {
          chrome.runtime.sendMessage({ type: 'OVERLAY_SAVE' }).catch(() => {});
        } catch {
          // ignore
        }
      } else if (mode === 'article' && e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        expandSelection();
      } else if (mode === 'article' && e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        shrinkSelection();
      }
    }

    function onScrollOrResize() {
      if (mode === 'screenshot' && !adjusted) {
        cropRect = {
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      }
      scheduleRender();
    }

    function onSelectionChange() {
      if (mode !== 'selection') return;
      scheduleRender();
      notifyPanel();
    }

    function attachListeners() {
      if (listenersAttached) return;
      listenersAttached = true;
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerUp, true);
      window.addEventListener('click', onClickCapture, true);
      window.addEventListener('auxclick', onAuxClickCapture, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('resize', onScrollOrResize, true);
      document.addEventListener('selectionchange', onSelectionChange, true);
    }

    function detachListeners() {
      if (!listenersAttached) return;
      listenersAttached = false;
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('auxclick', onAuxClickCapture, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize, true);
      document.removeEventListener('selectionchange', onSelectionChange, true);
    }

    function destroy() {
      stopAutoScroll();
      if (renderRaf) {
        window.cancelAnimationFrame(renderRaf);
        renderRaf = 0;
      }
      detachListeners();
      dragState = null;
      mode = 'off';
      adjusted = false;
      selectedElements = [];
      initialArticleElements = [];
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      const leftover = document.getElementById(HOST_ID);
      if (leftover) leftover.remove();
      host = null;
      shadow = null;
      ui = null;

      const lib = getLib();
      if (lib && typeof lib.cleanupTempIds === 'function') {
        lib.cleanupTempIds();
      }
    }

    function activate(nextMode) {
      if (nextMode !== 'article' && nextMode !== 'screenshot' && nextMode !== 'selection') {
        destroy();
        return buildStatePayload();
      }

      destroy();
      mode = nextMode;
      buildDom();
      attachListeners();

      if (mode === 'article') {
        const lib = getLib();
        const detected =
          lib && typeof lib.detectArticleLiveDom === 'function'
            ? lib.detectArticleLiveDom()
            : { elements: [], meta: {}, summary: { words: 0, images: 0 } };
        initialArticleElements = detected.elements || [];
        initialArticleSummary = detected.summary || { words: 0, images: 0 };
        initialArticleMeta = detected.meta || {};
        selectedElements = [...initialArticleElements];
        lastSummary = { ...initialArticleSummary };
        adjusted = false;
      } else if (mode === 'screenshot') {
        cropRect = {
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
        adjusted = false;
      }

      render();
      const payload = buildStatePayload();
      notifyPanel();
      return payload;
    }

    function hideForCapture() {
      if (host) {
        host.style.display = 'none';
      }
      return new Promise((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve(true));
        });
      });
    }

    return {
      activate,
      destroy,
      reset: resetSelection,
      expand: expandSelection,
      shrink: shrinkSelection,
      hideForCapture,
      getState: buildStatePayload,
      getSelectedElements: () => selectedElements.slice(),
      getArticleMeta: () => initialArticleMeta,
      isAdjusted: () => adjusted,
    };
  }

  const controller = createOverlayController();
  globalThis.__joplinClipperOverlay = controller;

  if (!globalThis.__joplinClipperOverlayMessageBound) {
    globalThis.__joplinClipperOverlayMessageBound = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'OVERLAY_DESTROY') {
        controller.destroy();
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === 'OVERLAY_RESET') {
        controller.reset();
        sendResponse({ ok: true, state: controller.getState() });
        return false;
      }
      return false;
    });
  }
})();
