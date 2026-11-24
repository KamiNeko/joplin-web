(() => {
  'use strict';

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

  function stripUnsafeElements(root) {
    const junk = root.querySelectorAll('script, style, iframe, object, embed, form, noscript, template');
    for (const el of Array.from(junk)) {
      el.remove();
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        const lower = attr.name.toLowerCase();
        if (lower.startsWith('on') || lower === 'srcdoc') {
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  function cloneVisibleBody() {
    const clone = document.body.cloneNode(true);
    // Walk live DOM and clone in parallel to prune hidden elements without mutating the live page
    const pruneHidden = (liveEl, cloneEl) => {
      const liveChildren = Array.from(liveEl.children);
      const cloneChildren = Array.from(cloneEl.children);
      const len = Math.min(liveChildren.length, cloneChildren.length);
      for (let i = len - 1; i >= 0; i--) {
        const lc = liveChildren[i];
        const cc = cloneChildren[i];
        let hidden = lc.hasAttribute('hidden') || lc.getAttribute('aria-hidden') === 'true';
        if (!hidden) {
          try {
            const style = window.getComputedStyle(lc);
            if (style.display === 'none' || style.visibility === 'hidden') {
              hidden = true;
            }
          } catch {
            // ignore style errors
          }
        }
        if (hidden) {
          cc.remove();
        } else {
          pruneHidden(lc, cc);
        }
      }
    };
    pruneHidden(document.body, clone);
    return clone;
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

  globalThis.__joplinClipperInspect = () => {
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    const title =
      getMetaContent(['meta[property="og:title"]']) ||
      (document.title || '').trim() ||
      window.location.hostname;
    return {
      url: window.location.href,
      title,
      hasSelection: selText.length > 0,
      selectionLength: selText.length,
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

    // Default: 'article' mode via Readability on a clone of the live DOM
    const docClone = document.cloneNode(true);
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
