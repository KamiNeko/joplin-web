(() => {
  'use strict';

  const OVERLAY_HOST_ID = 'joplin-clipper-overlay-host';
  const TEMP_ID_ATTR = 'data-joplin-clip-id';

  const UNSAFE_SELECTOR = 'script, style, iframe, object, embed, form, noscript, template';
  const ADJUSTED_UNSAFE_SELECTOR = 'script, style, iframe, object, embed, form, button, noscript, template';

  function pickLargestFromSrcset(srcset) {
    if (!srcset) return '';
    let bestUrl = '';
    let bestScore = -1;
    // Split on commas followed by whitespace and a non-whitespace URL token (handles URLs with commas like Cloudinary)
    const parts = srcset.split(/,(?=\s*\S)/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const candidate = tokens[0];
      if (!candidate) continue;
      const descriptor = tokens[1] || '';
      let score = 0;
      const wMatch = /^(\d+)w$/i.exec(descriptor);
      const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
      if (wMatch) score = Number(wMatch[1]);
      else if (xMatch) score = Number(xMatch[1]) * 1000;
      if (score >= bestScore) {
        bestScore = score;
        bestUrl = candidate;
      }
    }
    return bestUrl;
  }

  function isPlaceholderSrc(src) {
    if (!src) return true;
    const lower = src.trim().toLowerCase();
    if (!lower) return true;
    if (lower.startsWith('data:image/gif;base64,r0lgodlh')) return true;
    if (lower.startsWith('data:image/svg+xml')) return true;
    return false;
  }

  function resolveAbsoluteUrl(rawUrl, baseUrl) {
    if (!rawUrl) return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';
    if (/^(data|blob):/i.test(trimmed)) return trimmed;
    if (/^(javascript|vbscript):/i.test(trimmed.replace(/[\u0000-\u0020]+/g, ''))) return '';
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return '';
    }
  }

  function resolveBestImageSrc(img, baseUrl) {
    const lazySrc =
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-actualsrc') ||
      '';
    const lazySrcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || '';
    const srcset = img.getAttribute('srcset') || '';
    const rawSrc = img.getAttribute('src') || '';

    let chosen = '';
    if (lazySrcset) chosen = pickLargestFromSrcset(lazySrcset);
    if (!chosen && srcset) chosen = pickLargestFromSrcset(srcset);
    if (!chosen && lazySrc && isPlaceholderSrc(rawSrc)) chosen = lazySrc;
    if (!chosen && !isPlaceholderSrc(rawSrc)) chosen = rawSrc;
    if (!chosen && lazySrc) chosen = lazySrc;
    if (!chosen && rawSrc) chosen = rawSrc;

    return resolveAbsoluteUrl(chosen, baseUrl);
  }

  function normalizePictureElements(root, baseUrl) {
    const pictures = Array.from(root.querySelectorAll('picture'));
    for (const pic of pictures) {
      const img = pic.querySelector('img');
      if (!img) continue;
      let bestSourceUrl = '';
      for (const source of Array.from(pic.querySelectorAll('source'))) {
        const type = (source.getAttribute('type') || '').toLowerCase();
        // Prefer standard raster formats if multiple sources exist, otherwise take first valid
        const candidate = pickLargestFromSrcset(
          source.getAttribute('srcset') || source.getAttribute('data-srcset') || ''
        );
        if (candidate && (!bestSourceUrl || /image\/(png|jpeg|jpg|webp|gif)/.test(type))) {
          bestSourceUrl = candidate;
        }
      }
      const existingResolved = resolveBestImageSrc(img, baseUrl);
      const finalUrl = resolveAbsoluteUrl(bestSourceUrl, baseUrl) || existingResolved;
      if (finalUrl) {
        img.setAttribute('src', finalUrl);
        img.removeAttribute('srcset');
      }
      pic.replaceWith(img);
    }
  }

  function normalizeDomUrls(root, baseUrl) {
    normalizePictureElements(root, baseUrl);

    for (const img of Array.from(root.querySelectorAll('img'))) {
      const resolved = resolveBestImageSrc(img, baseUrl);
      if (resolved) {
        img.setAttribute('src', resolved);
      } else {
        img.removeAttribute('src');
      }
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      img.removeAttribute('data-original');
      img.removeAttribute('data-lazy-src');
      img.removeAttribute('data-srcset');
      img.removeAttribute('data-lazy-srcset');
      img.removeAttribute('data-actualsrc');
    }

    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      const raw = a.getAttribute('href') || '';
      if (raw.trim().startsWith('#')) continue;
      const resolved = resolveAbsoluteUrl(raw, baseUrl);
      if (resolved) {
        a.setAttribute('href', resolved);
      } else {
        a.removeAttribute('href');
      }
    }
  }

  function stripUnsafeElements(root, selector = UNSAFE_SELECTOR) {
    const overlayInRoot = root.querySelector ? root.querySelector(`#${OVERLAY_HOST_ID}`) : null;
    if (overlayInRoot) overlayInRoot.remove();

    const junk = root.querySelectorAll(selector);
    for (const el of Array.from(junk)) {
      el.remove();
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      el.removeAttribute(TEMP_ID_ATTR);
      for (const attr of Array.from(el.attributes)) {
        const lower = attr.name.toLowerCase();
        if (lower.startsWith('on') || lower === 'srcdoc') {
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  function isLiveElementHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.id === OVERLAY_HOST_ID) return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch {
      // ignore style errors
    }
    return false;
  }

  function pruneHiddenClone(liveEl, cloneEl) {
    const liveChildren = Array.from(liveEl.children);
    const cloneChildren = Array.from(cloneEl.children);
    const len = Math.min(liveChildren.length, cloneChildren.length);
    for (let i = len - 1; i >= 0; i--) {
      const lc = liveChildren[i];
      const cc = cloneChildren[i];
      if (isLiveElementHidden(lc)) {
        cc.remove();
      } else {
        pruneHiddenClone(lc, cc);
      }
    }
  }

  function cloneVisibleElement(liveEl) {
    const clone = liveEl.cloneNode(true);
    pruneHiddenClone(liveEl, clone);
    return clone;
  }

  function cloneVisibleBody() {
    return cloneVisibleElement(document.body);
  }

  function tokenizeImages(root) {
    const images = [];
    const urlToToken = new Map();
    for (const img of Array.from(root.querySelectorAll('img[src]'))) {
      const src = (img.getAttribute('src') || '').trim();
      if (!src || !/^(https?:|data:)/i.test(src)) continue;
      let token = urlToToken.get(src);
      if (!token) {
        token = `__JOPLIN_IMG_${images.length}__`;
        urlToToken.set(src, token);
        images.push({
          token,
          url: src,
          alt: (img.getAttribute('alt') || '').trim(),
        });
      }
      img.setAttribute('src', token);
    }
    return images;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getMetaContent(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const val = el && el.getAttribute('content');
      if (val && val.trim()) return val.trim();
    }
    return '';
  }

  function countWords(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return 0;
    return cleaned.split(/\s+/).filter(Boolean).length;
  }

  function summarizeContainer(root, baseUrl) {
    const clone = root.cloneNode(true);
    stripUnsafeElements(clone, ADJUSTED_UNSAFE_SELECTOR);
    normalizeDomUrls(clone, baseUrl);
    const words = countWords(clone.textContent || '');
    const seenUrls = new Set();
    for (const img of Array.from(clone.querySelectorAll('img[src]'))) {
      const src = (img.getAttribute('src') || '').trim();
      if (src && /^(https?:|data:)/i.test(src)) {
        seenUrls.add(src);
      }
    }
    return { words, images: seenUrls.size };
  }

  function summarizeLiveElements(elements) {
    const baseUrl = document.baseURI || window.location.href;
    const wrapper = document.createElement('div');
    for (const el of elements || []) {
      if (!el || !el.isConnected || isLiveElementHidden(el)) continue;
      wrapper.appendChild(cloneVisibleElement(el));
    }
    return summarizeContainer(wrapper, baseUrl);
  }

  function summarizeSelection() {
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    if (!sel || sel.rangeCount === 0 || !selText) {
      return { hasSelection: false, words: 0, images: 0 };
    }
    const baseUrl = document.baseURI || window.location.href;
    const wrapper = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      wrapper.appendChild(sel.getRangeAt(i).cloneContents());
    }
    const summary = summarizeContainer(wrapper, baseUrl);
    return { hasSelection: true, words: summary.words, images: summary.images };
  }

  function cleanupTempIds() {
    for (const el of Array.from(document.querySelectorAll(`[${TEMP_ID_ATTR}]`))) {
      el.removeAttribute(TEMP_ID_ATTR);
    }
  }

  function getVisibleRect(el) {
    if (!el || !el.isConnected || isLiveElementHidden(el)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return rect;
  }

  function getElementVisibleTextLen(el) {
    if (!el || isLiveElementHidden(el)) return 0;
    const tag = el.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|OBJECT|EMBED)$/.test(tag)) return 0;
    let total = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        total += (node.textContent || '').trim().length;
      } else if (node.nodeType === 1) {
        total += getElementVisibleTextLen(node);
      }
    }
    return total;
  }

  function lowestCommonAncestor(elements) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return elements[0];
    const chains = elements.map((el) => {
      const chain = [];
      let cur = el;
      while (cur) {
        chain.push(cur);
        cur = cur.parentElement;
      }
      return chain.reverse();
    });
    let lca = null;
    const minLen = Math.min(...chains.map((c) => c.length));
    for (let i = 0; i < minLen; i++) {
      const candidate = chains[0][i];
      if (chains.every((c) => c[i] === candidate)) {
        lca = candidate;
      } else {
        break;
      }
    }
    return lca;
  }

  function dedupeTopMostInDocumentOrder(elements) {
    const unique = Array.from(new Set(elements.filter((el) => el && el.isConnected)));
    const filtered = unique.filter(
      (el) => !unique.some((other) => other !== el && other.contains(el))
    );
    filtered.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return filtered;
  }

  function isMetadataOrHeading(el) {
    if (!el) return false;
    if (/^H[1-6]$/.test(el.tagName)) return true;
    const hint = `${el.className || ''} ${el.id || ''}`.toLowerCase();
    if (/(byline|author|meta|date|time|subtitle|kicker|standfirst|header)/.test(hint)) return true;
    if (el.tagName === 'HEADER' || el.tagName === 'TIME') return true;
    return false;
  }

  function containerHasSubstantialUnmatchedChild(container, matchedLiveSet) {
    for (const child of Array.from(container.children)) {
      if (isLiveElementHidden(child)) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|FORM|BUTTON|IFRAME|OBJECT|EMBED)$/.test(child.tagName)) {
        continue;
      }
      if (matchedLiveSet.has(child)) continue;
      let containsMatched = false;
      for (const m of matchedLiveSet) {
        if (child.contains(m)) {
          containsMatched = true;
          break;
        }
      }
      if (containsMatched) {
        if (containerHasSubstantialUnmatchedChild(child, matchedLiveSet)) return true;
        continue;
      }
      if (isMetadataOrHeading(child)) continue;
      const textLen = getElementVisibleTextLen(child);
      const hasImg = Boolean(child.querySelector('img') || child.tagName === 'IMG');
      if (textLen >= 30 || hasImg) {
        return true;
      }
    }
    return false;
  }

  function detectArticleLiveDom() {
    const baseUrl = document.baseURI || window.location.href;
    const idToLive = new Map();
    let seq = 0;

    let docClone = null;
    try {
      const body = document.body;
      if (body) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
        let node = walker.currentNode;
        while (node) {
          if (
            node !== body &&
            node.id !== OVERLAY_HOST_ID &&
            !node.closest(`#${OVERLAY_HOST_ID}`) &&
            !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)
          ) {
            const id = String(++seq);
            node.setAttribute(TEMP_ID_ATTR, id);
            idToLive.set(id, node);
          }
          node = walker.nextNode();
        }
      }
      docClone = document.cloneNode(true);
    } finally {
      cleanupTempIds();
    }

    if (docClone) {
      const overlayClone = docClone.getElementById(OVERLAY_HOST_ID);
      if (overlayClone) overlayClone.remove();
      normalizeDomUrls(docClone, baseUrl);
    }

    let parsed = null;
    if (docClone && typeof Readability === 'function') {
      try {
        parsed = new Readability(docClone).parse();
      } catch {
        parsed = null;
      }
    }

    let selectedElements = [];
    let summary = { words: 0, images: 0 };

    if (parsed && parsed.content) {
      const container = document.createElement('div');
      container.innerHTML = parsed.content;

      const matchedLive = [];
      const matchedLiveSet = new Set();
      for (const el of Array.from(container.querySelectorAll(`[${TEMP_ID_ATTR}]`))) {
        const id = el.getAttribute(TEMP_ID_ATTR);
        const liveEl = idToLive.get(id);
        if (
          liveEl &&
          liveEl.isConnected &&
          liveEl !== document.body &&
          liveEl !== document.documentElement &&
          getVisibleRect(liveEl)
        ) {
          if (!matchedLiveSet.has(liveEl)) {
            matchedLiveSet.add(liveEl);
            matchedLive.push(liveEl);
          }
        }
      }

      // Filter out overly broad containers that include substantial unmatched siblings in the live DOM
      const cleanMatched = matchedLive.filter(
        (el) => !containerHasSubstantialUnmatchedChild(el, matchedLiveSet)
      );
      const topMost = dedupeTopMostInDocumentOrder(cleanMatched.length > 0 ? cleanMatched : matchedLive);

      if (topMost.length === 1) {
        selectedElements = topMost;
      } else if (topMost.length > 1) {
        const lca = lowestCommonAncestor(topMost);
        if (
          lca &&
          lca !== document.body &&
          lca !== document.documentElement &&
          getVisibleRect(lca) &&
          !containerHasSubstantialUnmatchedChild(lca, matchedLiveSet)
        ) {
          selectedElements = [lca];
        } else {
          selectedElements = topMost;
        }
      }

      // If single matched element is a child of an <article> whose only extra children are title/byline,
      // promote to the <article> so the box covers the full article block.
      if (selectedElements.length === 1) {
        const articleAncestor = selectedElements[0].closest('article');
        if (
          articleAncestor &&
          articleAncestor !== selectedElements[0] &&
          articleAncestor !== document.body &&
          getVisibleRect(articleAncestor) &&
          !containerHasSubstantialUnmatchedChild(articleAncestor, matchedLiveSet)
        ) {
          selectedElements = [articleAncestor];
        }
      }

      // Clean temp IDs from parsed.content summary calculation
      summary = summarizeContainer(container, baseUrl);
    }

    if (selectedElements.length === 0) {
      const fallback =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      if (fallback && getVisibleRect(fallback)) {
        selectedElements = [fallback];
      }
      summary = summarizeLiveElements(selectedElements);
    }

    return { elements: selectedElements, parsed, summary };
  }

  function captureElementsAsMarkdown(elements) {
    const baseUrl = document.baseURI || window.location.href;
    const pageUrl = window.location.href;
    const fallbackTitle = (document.title || '').trim() || window.location.hostname || 'Clipped Page';
    const siteName = getMetaContent(['meta[property="og:site_name"]']) || undefined;

    const ordered = dedupeTopMostInDocumentOrder(elements || []);
    const wrapper = document.createElement('div');
    for (const el of ordered) {
      if (!el || !el.isConnected || isLiveElementHidden(el)) continue;
      wrapper.appendChild(cloneVisibleElement(el));
    }

    stripUnsafeElements(wrapper, ADJUSTED_UNSAFE_SELECTOR);
    normalizeDomUrls(wrapper, baseUrl);
    const images = tokenizeImages(wrapper);
    const html = wrapper.innerHTML.trim();
    if (!html) {
      throw new Error('The selected region contains no clippable content.');
    }

    return {
      url: pageUrl,
      title: fallbackTitle,
      html,
      format: 'markdown',
      siteName,
      images,
    };
  }

  globalThis.__joplinClipperLib = {
    OVERLAY_HOST_ID,
    TEMP_ID_ATTR,
    isLiveElementHidden,
    getVisibleRect,
    dedupeTopMostInDocumentOrder,
    lowestCommonAncestor,
    detectArticleLiveDom,
    captureElementsAsMarkdown,
    summarizeLiveElements,
    summarizeSelection,
    cleanupTempIds,
  };

  globalThis.__joplinClipperInspect = () => {
    const selSummary = summarizeSelection();
    const title =
      getMetaContent(['meta[property="og:title"]']) ||
      (document.title || '').trim() ||
      window.location.hostname;
    const isPdf =
      String(document.contentType || '').toLowerCase() === 'application/pdf' ||
      Boolean(
        document.body &&
          document.body.children.length === 1 &&
          document.body.children[0].tagName === 'EMBED' &&
          String(document.body.children[0].getAttribute('type') || '').toLowerCase() === 'application/pdf'
      );
    return {
      url: window.location.href,
      title,
      hasSelection: selSummary.hasSelection,
      selectionWords: selSummary.words,
      selectionImages: selSummary.images,
      isPdf,
    };
  };

  globalThis.__joplinClipperCapture = (mode, options = {}) => {
    const baseUrl = document.baseURI || window.location.href;
    const pageUrl = window.location.href;
    const fallbackTitle = (document.title || '').trim() || window.location.hostname || 'Clipped Page';
    const siteName = getMetaContent(['meta[property="og:site_name"]']) || undefined;

    if (mode === 'selection') {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) {
        throw new Error('No text or content is currently selected on this page.');
      }
      const wrapper = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) {
        wrapper.appendChild(sel.getRangeAt(i).cloneContents());
      }
      stripUnsafeElements(wrapper);
      normalizeDomUrls(wrapper, baseUrl);
      const images = tokenizeImages(wrapper);
      const html = wrapper.innerHTML.trim();
      if (!html) {
        throw new Error('The current selection is empty.');
      }
      return {
        url: pageUrl,
        title: fallbackTitle,
        html,
        format: 'markdown',
        siteName,
        images,
      };
    }

    if (mode === 'fullpage') {
      const bodyClone = cloneVisibleBody();
      stripUnsafeElements(bodyClone);
      normalizeDomUrls(bodyClone, baseUrl);
      const images = tokenizeImages(bodyClone);
      const html = bodyClone.innerHTML.trim();
      if (!html) {
        throw new Error('Could not capture any visible content from this page.');
      }
      return {
        url: pageUrl,
        title: fallbackTitle,
        html,
        format: 'html',
        siteName,
        images,
      };
    }

    if (mode === 'bookmark') {
      const title = getMetaContent(['meta[property="og:title"]']) || fallbackTitle;
      const description = getMetaContent([
        'meta[property="og:description"]',
        'meta[name="description"]',
        'meta[name="twitter:description"]',
      ]);
      const rawOgImage = getMetaContent([
        'meta[property="og:image"]',
        'meta[property="og:image:secure_url"]',
        'meta[name="twitter:image"]',
      ]);
      const ogImage = resolveAbsoluteUrl(rawOgImage, baseUrl);

      const wrapper = document.createElement('div');
      const parts = [];
      if (ogImage && /^(https?:|data:)/i.test(ogImage)) {
        parts.push(`<p><img src="${escapeHtml(ogImage)}" alt="${escapeHtml(title)}"></p>`);
      }
      if (description) {
        parts.push(`<p>${escapeHtml(description)}</p>`);
      }
      parts.push(`<p><a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a></p>`);
      wrapper.innerHTML = parts.join('\n');
      const images = tokenizeImages(wrapper);
      return {
        url: pageUrl,
        title,
        html: wrapper.innerHTML.trim(),
        format: 'markdown',
        siteName,
        images,
      };
    }

    // Article mode: if the user adjusted the overlay area, save the highlighted elements
    if (
      options &&
      options.useOverlaySelection &&
      globalThis.__joplinClipperOverlay &&
      typeof globalThis.__joplinClipperOverlay.isAdjusted === 'function' &&
      globalThis.__joplinClipperOverlay.isAdjusted()
    ) {
      const selected = globalThis.__joplinClipperOverlay.getSelectedElements();
      if (Array.isArray(selected) && selected.length > 0) {
        return captureElementsAsMarkdown(selected);
      }
    }

    // Default / unadjusted 'article' mode: Readability on a clone of the live DOM
    const docClone = document.cloneNode(true);
    const overlayClone = docClone.getElementById(OVERLAY_HOST_ID);
    if (overlayClone) overlayClone.remove();
    normalizeDomUrls(docClone, baseUrl);

    let parsed = null;
    if (typeof Readability === 'function') {
      try {
        parsed = new Readability(docClone).parse();
      } catch {
        parsed = null;
      }
    }

    const container = document.createElement('div');
    if (parsed && parsed.content) {
      container.innerHTML = parsed.content;
    } else {
      const bodyClone = cloneVisibleBody();
      stripUnsafeElements(bodyClone);
      normalizeDomUrls(bodyClone, baseUrl);
      container.innerHTML = bodyClone.innerHTML;
    }

    stripUnsafeElements(container);
    normalizeDomUrls(container, baseUrl);
    const images = tokenizeImages(container);
    const html = container.innerHTML.trim();
    if (!html) {
      throw new Error('Could not extract readable content from this page. Try Full page or Bookmark mode.');
    }

    return {
      url: pageUrl,
      title: (parsed && parsed.title && parsed.title.trim()) || fallbackTitle,
      html,
      format: 'markdown',
      byline: (parsed && parsed.byline && parsed.byline.trim()) || undefined,
      siteName: (parsed && parsed.siteName && parsed.siteName.trim()) || siteName,
      images,
    };
  };
})();
