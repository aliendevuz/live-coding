// Duet live server client, injected into every HTML page it serves.
// Updates the page in place when project files change:
//   - CSS: the stylesheet is swapped (no flash, scroll and state kept)
//   - images: re-requested
//   - this page's HTML: re-fetched and only the changed nodes are patched
//   - scripts the page uses (or inline scripts that changed): full reload
(() => {
  if (window.__duetLive) return;
  window.__duetLive = true;
  const SELF = "__duet_live";
  const IMG = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;

  const pathOf = (url) => {
    try {
      return decodeURIComponent(new URL(url, location.href).pathname).replace(/^\//, "");
    } catch {
      return "";
    }
  };
  const pagePath = () => {
    const p = pathOf(location.href);
    return p === "" || p.endsWith("/") ? p + "index.html" : p;
  };
  const bust = (url) => {
    const u = new URL(url, location.href);
    u.searchParams.set("duet", Date.now().toString(36));
    return u.href;
  };

  function refreshCss(changed) {
    const links = [...document.querySelectorAll('link[rel~="stylesheet"]')];
    const hit = links.filter((l) => changed.includes(pathOf(l.href)));
    // A changed CSS file not linked directly (an @import): refresh them all.
    for (const old of hit.length ? hit : links) {
      const next = old.cloneNode();
      next.href = bust(old.href);
      next.onload = next.onerror = () => old.remove();
      old.after(next);
    }
  }

  function refreshImages(changed) {
    for (const img of document.images) if (changed.includes(pathOf(img.src))) img.src = bust(img.src);
    for (const el of document.querySelectorAll("[style*='url(']")) {
      el.style.cssText = el.style.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) =>
        changed.includes(pathOf(u)) ? `url(${q}${bust(u)}${q})` : m,
      );
    }
  }

  const usesScript = (changed) => [...document.scripts].some((s) => s.src && s.id !== SELF && changed.includes(pathOf(s.src)));

  const scriptsText = (doc) =>
    [...doc.querySelectorAll("script")]
      .filter((s) => s.id !== SELF)
      .map((s) => (s.src ? "src:" + pathOf(s.src) : s.textContent))
      .join("\u0000");

  const keep = (n) => !(n.nodeType === 1 && n.id === SELF) && !(n.nodeType === 3 && n.parentNode?.nodeName === "HEAD" && !n.nodeValue.trim());

  // Three-way patch: `a` is the live node, `b` the new source, `p` the same
  // node in the previous source. Only what changed in the source is applied,
  // so state the page's own JS created (classes, attributes, text) survives.
  function morph(a, b, p) {
    if (a.nodeType === 1) {
      for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && (!p || p.hasAttribute(name))) a.removeAttribute(name);
      for (const { name, value } of [...b.attributes]) {
        if (a.getAttribute(name) !== value && (!p || p.getAttribute(name) !== value)) a.setAttribute(name, value);
      }
      if (a.nodeName === "SCRIPT") return; // never re-run; script changes reload instead
      // Form fields: only a changed default in the source replaces what was typed.
      if ((a.nodeName === "TEXTAREA" || a.nodeName === "INPUT") && p && p.defaultValue !== b.defaultValue) a.value = b.defaultValue;
    }
    const ac = [...a.childNodes].filter(keep);
    const bc = [...b.childNodes].filter(keep);
    const pc = p ? [...p.childNodes].filter(keep) : [];
    bc.forEach((y, i) => {
      const x = ac[i];
      const q = pc[i] && pc[i].nodeType === y.nodeType && pc[i].nodeName === y.nodeName ? pc[i] : null;
      if (!x) a.appendChild(document.importNode(y, true));
      else if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) a.replaceChild(document.importNode(y, true), x);
      else if (x.nodeType === 1) morph(x, y, q);
      else if (x.nodeValue !== y.nodeValue && (!q || q.nodeValue !== y.nodeValue)) x.nodeValue = y.nodeValue;
    });
    for (let i = bc.length; i < ac.length; i++) ac[i].remove();
  }

  const fetchSource = async () => {
    const r = await fetch(location.href, { cache: "no-store" });
    return r.ok ? new DOMParser().parseFromString(await r.text(), "text/html") : null;
  };
  // The page as written (before its scripts ran), the base of the next patch.
  let prev = null;
  const prevReady = fetchSource().then((d) => (prev = d)).catch(() => {});

  async function patchPage() {
    await prevReady;
    const next = await fetchSource();
    if (!next) return;
    if (!prev || scriptsText(next) !== scriptsText(prev)) return location.reload();
    if (document.title !== next.title) document.title = next.title;
    // Head: keep stylesheets that stay (no flash), add new ones, drop removed ones.
    const sheet = (el) => (el.nodeName === "LINK" ? "link:" + pathOf(el.href) : el.nodeName === "STYLE" ? "style:" + el.textContent : null);
    const have = new Map([...document.head.querySelectorAll("link[rel~=stylesheet],style")].map((el) => [sheet(el), el]));
    const want = [...next.head.querySelectorAll("link[rel~=stylesheet],style")];
    const wanted = new Set(want.map(sheet));
    for (const [k, el] of have) if (!wanted.has(k)) el.remove();
    for (const el of want) if (!have.has(sheet(el))) document.head.appendChild(document.importNode(el, true));
    morph(document.body, next.body, prev.body);
    prev = next;
  }

  let busy = Promise.resolve();
  function onChange(changed) {
    if (changed.includes("*")) return location.reload();
    const here = pagePath();
    if (usesScript(changed)) return location.reload();
    if (changed.some((p) => /\.css$/i.test(p))) refreshCss(changed);
    if (changed.some((p) => IMG.test(p))) refreshImages(changed);
    if (changed.includes(here)) busy = busy.then(patchPage).catch(() => location.reload());
  }

  const es = new EventSource("/__duet/events");
  es.onmessage = (e) => {
    try {
      onChange(JSON.parse(e.data));
    } catch {}
  };
})();
