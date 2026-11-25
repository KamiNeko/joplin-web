(() => {
  'use strict';

  const OVERLAY_HOST_ID = 'joplin-clipper-overlay-host';
  const TEMP_ID_ATTR = 'data-joplin-clip-id';

  const UNSAFE_SELECTOR = 'script, style, iframe, object, embed, form, noscript, template';
  const BOILERPLATE_SELECTOR =
    'nav, aside, footer, [role="navigation"], [role="complementary"]';
  const ARTICLE_CLEAN_SELECTOR =
    'script, style, iframe, object, embed, form, button, noscript, template, ' +
    'nav, aside, footer, [role="navigation"], [role="complementary"], [aria-hidden="true"]';

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

  function summarizeCleanedRoot(root) {
    const words = countWords(root.textContent || '');
    const seenUrls = new Set();
    for (const img of Array.from(root.querySelectorAll('img[src]'))) {
      const src = (img.getAttribute('src') || '').trim();
      if (src && /^(https?:|data:)/i.test(src)) {
        seenUrls.add(src);
      }
    }
    return { words, images: seenUrls.size };
  }

  function buildCleanedElementsWrapper(elements, baseUrl) {
    const ordered = dedupeTopMostInDocumentOrder(elements || []);
    const wrapper = document.createElement('div');
    for (const el of ordered) {
      if (!el || !el.isConnected || isLiveElementHidden(el)) continue;
      wrapper.appendChild(cloneVisibleElement(el));
    }
    stripUnsafeElements(wrapper, ARTICLE_CLEAN_SELECTOR);
    normalizeDomUrls(wrapper, baseUrl);
    return wrapper;
  }

  function summarizeLiveElements(elements) {
    const baseUrl = document.baseURI || window.location.href;
    const wrapper = buildCleanedElementsWrapper(elements, baseUrl);
    return summarizeCleanedRoot(wrapper);
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
    stripUnsafeElements(wrapper, UNSAFE_SELECTOR);
    normalizeDomUrls(wrapper, baseUrl);
    const summary = summarizeCleanedRoot(wrapper);
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
    const unique = Array.from(new Set((elements || []).filter((el) => el && el.isConnected)));
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

  function containsBoilerplate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches(BOILERPLATE_SELECTOR)) return true;
    return Boolean(el.querySelector(BOILERPLATE_SELECTOR));
  }

  function isHeadingInSiteChrome(heading) {
    if (!heading || heading.nodeType !== 1) return true;
    if (heading.closest(BOILERPLATE_SELECTOR)) return true;
    const header = heading.closest('header');
    if (header && header.querySelector('nav, [role="navigation"]')) return true;
    return false;
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

  function normalizeTitleText(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractTitleTokens(str) {
    const matches = normalizeTitleText(str).match(/[\p{L}\p{N}]+/gu);
    return matches ? matches : [];
  }

  function buildTitleReferences(parsedTitle) {
    const raw = [];
    if (parsedTitle && String(parsedTitle).trim()) raw.push(String(parsedTitle).trim());
    if (document.title && document.title.trim()) raw.push(document.title.trim());

    const seen = new Set();
    const refs = [];
    const addRef = (text, isPrimary) => {
      const norm = normalizeTitleText(text);
      if (!norm || seen.has(norm)) return;
      const tokens = extractTitleTokens(norm);
      if (tokens.length === 0) return;
      seen.add(norm);
      refs.push({ norm, tokens, tokenSet: new Set(tokens), isPrimary });
    };

    for (const candidate of raw) {
      addRef(candidate, true);
      // Also consider the leading segment before common site-name separators (" | ", " - ", " — ", etc.)
      const split = candidate.split(/\s+(?:\||—|–|-|·|::)\s+/);
      if (split.length > 1 && split[0].trim().length >= 3) {
        addRef(split[0].trim(), true);
      }
    }
    return refs;
  }

  function scoreHeadingAgainstTitles(headingText, refs) {
    const norm = normalizeTitleText(headingText);
    if (!norm || norm.length < 2) return 0;
    const hTokens = extractTitleTokens(norm);
    if (hTokens.length === 0) return 0;
    const hSet = new Set(hTokens);

    let best = 0;
    for (const ref of refs) {
      if (norm === ref.norm) {
        best = Math.max(best, ref.isPrimary ? 1.15 : 1.0);
        continue;
      }
      let matchedH = 0;
      for (const tok of hTokens) {
        if (ref.tokenSet.has(tok)) matchedH++;
      }
      let matchedRef = 0;
      for (const tok of ref.tokens) {
        if (hSet.has(tok)) matchedRef++;
      }
      if (matchedH === 0) continue;

      const precision = matchedH / hTokens.length;
      const recall = matchedRef / ref.tokens.length;
      let score = (2 * precision * recall) / (precision + recall);
      if (ref.norm.startsWith(norm) || norm.startsWith(ref.norm)) {
        score += 0.15;
      } else if (ref.norm.includes(norm) || norm.includes(ref.norm)) {
        score += 0.05;
      }
      if (score > best) best = score;
    }
    return best;
  }

  function isElementBefore(a, b) {
    if (!a || !b || a === b) return false;
    if (a.contains(b) || b.contains(a)) return false;
    const pos = a.compareDocumentPosition(b);
    return Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function findBestArticleHeading(regionElements, parsedTitle) {
    if (!regionElements || regionElements.length === 0 || !document.body) return null;
    const refs = buildTitleReferences(parsedTitle);
    if (refs.length === 0) return null;

    const firstRegion = regionElements[0];
    const isInRegion = (el) => regionElements.some((r) => r === el || r.contains(el));

    const pickFromSelector = (selector, minScore) => {
      let bestEl = null;
      let bestScore = 0;
      for (const h of Array.from(document.body.querySelectorAll(selector))) {
        if (!getVisibleRect(h)) continue;
        if (isHeadingInSiteChrome(h)) continue;
        const inside = isInRegion(h);
        if (!inside && !isElementBefore(h, firstRegion)) continue;
        const score = scoreHeadingAgainstTitles(h.textContent || '', refs);
        if (score >= minScore && score > bestScore) {
          bestScore = score;
          bestEl = h;
        }
      }
      if (!bestEl) return null;
      // If the best matching heading is already inside the detected region, no extension is needed.
      if (isInRegion(bestEl)) return { alreadyIncluded: true, heading: bestEl };
      return { alreadyIncluded: false, heading: bestEl };
    };

    // Prefer h1 first; fall back to h2 only when no h1 matches (e.g. blogs whose post title is an h2).
    const h1Result = pickFromSelector('h1', 0.45);
    if (h1Result) {
      return h1Result.alreadyIncluded ? null : h1Result.heading;
    }
    const h2Result = pickFromSelector('h2', 0.65);
    if (h2Result) {
      return h2Result.alreadyIncluded ? null : h2Result.heading;
    }
    return null;
  }

  function directChildOfAncestor(el, ancestor) {
    let cur = el;
    while (cur && cur.parentElement && cur.parentElement !== ancestor) {
      cur = cur.parentElement;
    }
    return cur && cur.parentElement === ancestor ? cur : null;
  }

  function extendRegionWithHeading(regionElements, parsedTitle) {
    if (!regionElements || regionElements.length === 0) return regionElements;
    const heading = findBestArticleHeading(regionElements, parsedTitle);
    if (!heading) return regionElements;

    const lca = lowestCommonAncestor([heading, ...regionElements]);
    if (
      lca &&
      lca !== document.body &&
      lca !== document.documentElement &&
      getVisibleRect(lca) &&
      !containsBoilerplate(lca)
    ) {
      return [lca];
    }

    // If LCA is not body/html (e.g. a <main> that also contains a sidebar <aside>),
    // climb the heading branch to the clean direct child of LCA and include clean siblings
    // between the heading branch and the region (e.g. MDN's layout__header + layout__body).
    if (lca && lca !== document.body && lca !== document.documentElement) {
      const headingBranch = directChildOfAncestor(heading, lca);
      const regionBranch = directChildOfAncestor(regionElements[0], lca);
      if (
        headingBranch &&
        regionBranch &&
        headingBranch !== regionBranch &&
        getVisibleRect(headingBranch) &&
        !containsBoilerplate(headingBranch) &&
        !isHeadingInSiteChrome(headingBranch)
      ) {
        const siblings = Array.from(lca.children);
        const startIdx = siblings.indexOf(headingBranch);
        const endIdx = siblings.indexOf(regionBranch);
        if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
          const picked = [headingBranch];
          for (let i = startIdx + 1; i < endIdx; i++) {
            const sib = siblings[i];
            if (
              !getVisibleRect(sib) ||
              containsBoilerplate(sib) ||
              /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|FORM|BUTTON|IFRAME|OBJECT|EMBED)$/.test(sib.tagName)
            ) {
              continue;
            }
            picked.push(sib);
          }
          picked.push(...regionElements);
          return dedupeTopMostInDocumentOrder(picked);
        }
      }
    }

    // Fallback: multi-element selection of the heading plus the region (never growing to body).
    return dedupeTopMostInDocumentOrder([heading, ...regionElements]);
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
          !containsBoilerplate(lca) &&
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
          !containsBoilerplate(articleAncestor) &&
          !containerHasSubstantialUnmatchedChild(articleAncestor, matchedLiveSet)
        ) {
          selectedElements = [articleAncestor];
        }
      }
    }

    if (selectedElements.length === 0) {
      const fallback =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      if (fallback && getVisibleRect(fallback)) {
        selectedElements = [fallback];
      }
    }

    const parsedTitle = (parsed && parsed.title && parsed.title.trim()) || '';
    selectedElements = extendRegionWithHeading(selectedElements, parsedTitle);

    const meta = {
      title: parsedTitle || undefined,
      byline: (parsed && parsed.byline && parsed.byline.trim()) || undefined,
      siteName: (parsed && parsed.siteName && parsed.siteName.trim()) || undefined,
    };

    // Always compute the summary from the exact same cleaned output that gets saved.
    const summary = summarizeLiveElements(selectedElements);

    return { elements: selectedElements, parsed, meta, summary };
  }

  function captureElementsAsMarkdown(elements, meta = {}) {
    const baseUrl = document.baseURI || window.location.href;
    const pageUrl = window.location.href;
    const fallbackTitle = (document.title || '').trim() || window.location.hostname || 'Clipped Page';
    const siteName =
      (meta && meta.siteName) || getMetaContent(['meta[property="og:site_name"]']) || undefined;

    const wrapper = buildCleanedElementsWrapper(elements, baseUrl);
    const images = tokenizeImages(wrapper);
    const html = wrapper.innerHTML.trim();
    if (!html) {
      throw new Error('The selected region contains no clippable content.');
    }

    return {
      url: pageUrl,
      title: (meta && meta.title) || fallbackTitle,
      html,
      format: 'markdown',
      ...(meta && meta.byline ? { byline: meta.byline } : {}),
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

  globalThis.__joplinClipperCapture = (mode) => {
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

    // Article mode: what is saved always equals what is highlighted (Readability only picks the default box).
    if (
      globalThis.__joplinClipperOverlay &&
      typeof globalThis.__joplinClipperOverlay.getSelectedElements === 'function'
    ) {
      const selected = globalThis.__joplinClipperOverlay.getSelectedElements();
      if (Array.isArray(selected) && selected.length > 0) {
        const meta =
          typeof globalThis.__joplinClipperOverlay.getArticleMeta === 'function'
            ? globalThis.__joplinClipperOverlay.getArticleMeta()
            : {};
        return captureElementsAsMarkdown(selected, meta);
      }
    }

    const detected = detectArticleLiveDom();
    if (detected.elements.length > 0) {
      return captureElementsAsMarkdown(detected.elements, detected.meta);
    }

    throw new Error('Could not extract readable content from this page. Try Full page or Bookmark mode.');
  };
})();
