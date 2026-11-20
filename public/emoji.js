// One emoji look on every phone and browser. Instead of trusting the device's own emoji font (which draws some,
// like ♥, as a plain white symbol), every emoji on the page is swapped for the same picture from Google's
// open-source emoji set, served from this site. Typing fields keep the device's emoji; everything shown is swapped.
(function () {
  const BASE = '/vendor/emoji/g16/';
  // emoji-looking sequences: flags, keycaps, and pictographs with their skin tones / joiners
  const RX = /(?:\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]️?⃣|\p{Extended_Pictographic}[︎️]?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)/gu;
  const EP = /\p{Emoji_Presentation}/u, PICT = /\p{Extended_Pictographic}/u;
  // symbols that phones often draw as plain text unless told otherwise; we always draw them as emoji
  const TEXTY = new Set([0x2764, 0x2665, 0x2666, 0x2663, 0x2660, 0x263a, 0x2639, 0x270c, 0x261d, 0x270d, 0x2620, 0x2600, 0x2601, 0x2602, 0x2603, 0x2604, 0x26a0, 0x2618, 0x2734, 0x2733, 0x2747]);
  let have = null, waiting = [];
  const hex = (c) => c.toString(16).padStart(4, '0');
  function wanted(m) {
    if (m.includes('︎')) return false;                  // explicitly asked for the text style
    const first = m.codePointAt(0);
    return m.length > 2 || /[️‍⃣]/.test(m) || /\p{Emoji_Modifier}|\p{Regional_Indicator}/u.test(m) || EP.test(String.fromCodePoint(first)) || TEXTY.has(first);
  }
  function file(m) {
    if (!have) return null;
    const cps = [...m].map((ch) => ch.codePointAt(0));
    const exact = cps.map(hex).join('-');
    const bare = cps.filter((c) => c !== 0xfe0f).map(hex).join('-');
    const full = [];                                          // add the emoji-style marker where the full form has it
    cps.forEach((c, i) => { if (c === 0xfe0f) return; full.push(hex(c)); const ch = String.fromCodePoint(c); if (PICT.test(ch) && !EP.test(ch) && !(cps[i + 1] >= 0x1f3fb && cps[i + 1] <= 0x1f3ff)) full.push('fe0f'); });
    for (const k of [exact, full.join('-'), bare]) if (have.has(k)) return k;
    return null;
  }
  const url = (m) => { const f = file(m); return f ? BASE + f + '.png' : null; };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION', 'TITLE', 'CANVAS']);
  function swapText(node) {
    const s = node.nodeValue; if (!s || !RX.test(s)) return; RX.lastIndex = 0;
    const p = node.parentNode; if (!p || SKIP.has(p.nodeName) || (p.closest && p.closest('[data-noemo]'))) return;
    const frag = document.createDocumentFragment(); let last = 0, hit = false;
    for (const mm of s.matchAll(RX)) {
      const m = mm[0], u = wanted(m) && url(m); if (!u) continue;
      hit = true;
      if (mm.index > last) frag.append(s.slice(last, mm.index));
      const im = document.createElement('img'); im.className = 'emo'; im.src = u; im.alt = m; im.draggable = false; im.decoding = 'async';
      im.onerror = () => im.replaceWith(m);               // missing picture: fall back to the device's own emoji
      frag.append(im); last = mm.index + m.length;
    }
    if (!hit) return;
    if (last < s.length) frag.append(s.slice(last));
    p.replaceChild(frag, node);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return swapText(root);
    if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = [];
    while (tw.nextNode()) list.push(tw.currentNode);
    list.forEach(swapText);
  }
  const mo = new MutationObserver((recs) => {
    if (!have) { waiting.push(...recs); return; }
    for (const r of recs) { if (r.type === 'characterData') swapText(r.target); else r.addedNodes.forEach(walk); }
  });
  function start() {
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    fetch(BASE + 'list.txt').then((r) => (r.ok ? r.text() : '')).then((txt) => {
      have = new Set(txt.split(',').filter(Boolean));
      if (!have.size) { mo.disconnect(); return; }           // pictures unavailable: keep the device's emoji
      walk(document.body); waiting = [];
      window.dispatchEvent(new Event('emoji-ready'));
    }).catch(() => mo.disconnect());
  }
  const css = document.createElement('style');
  css.textContent = 'img.emo{width:1.2em;height:1.2em;vertical-align:-0.22em;display:inline-block;object-fit:contain;pointer-events:none;-webkit-user-drag:none;user-select:none}';
  document.head.appendChild(css);
  window.EMO = { url: (m) => (wanted(m) ? url(m) : null), split: (s) => [...String(s).matchAll(RX)].map((x) => x[0]) };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
