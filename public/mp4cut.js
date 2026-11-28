// STONX fast MP4 cutter — no ffmpeg, no re-encoding.
// Reads the movie's index (moov) once, then builds each part as a tiny new header + byte slices of the
// original file. Cutting a 2-hour film takes seconds instead of minutes, even on a phone.

const T4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const U64 = (dv, o) => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);

function* kids(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o), hdr = 8;
    const t = T4(dv, o + 4);
    if (size === 1) { size = U64(dv, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { t, o, size, body: o + hdr, end: o + size };
    o += size;
  }
}
const kid = (dv, b, t) => { if (!b) return null; for (const c of kids(dv, b.body, b.end)) if (c.t === t) return c; return null; };
const kidsOf = (dv, b, t) => [...kids(dv, b.body, b.end)].filter((c) => c.t === t);

async function scanTop(file) {
  let o = 0, moov = null;
  while (o + 8 <= file.size) {
    const dv = new DataView(await file.slice(o, Math.min(o + 16, file.size)).arrayBuffer());
    let size = dv.getUint32(0);
    const t = T4(dv, 4);
    if (size === 1) size = U64(dv, 8); else if (size === 0) size = file.size - o;
    if (size < 8) return null;
    if (t === 'moov') moov = { o, size };
    o += size;
  }
  return moov;
}

function parseTrak(dv, trak) {
  const tkhd = kid(dv, trak, 'tkhd'), mdia = kid(dv, trak, 'mdia');
  const mdhd = kid(dv, mdia, 'mdhd'), hdlr = kid(dv, mdia, 'hdlr');
  const stbl = kid(dv, kid(dv, mdia, 'minf'), 'stbl');
  if (!tkhd || !mdhd || !hdlr || !stbl) return null;
  const handler = T4(dv, hdlr.body + 8);
  const mv = dv.getUint8(mdhd.body);
  const ts = dv.getUint32(mdhd.body + (mv ? 20 : 12));
  const lang = dv.getUint16(mdhd.body + (mv ? 32 : 20));
  const tb = tkhd.body + (dv.getUint8(tkhd.body) ? 12 : 0);
  const matrix = new Uint8Array(dv.buffer, dv.byteOffset + tb + 40, 36).slice();
  const width = dv.getUint32(tb + 76), height = dv.getUint32(tb + 80);

  let mediaTime = 0;
  const elst = kid(dv, kid(dv, trak, 'edts'), 'elst');
  if (elst) {
    const v = dv.getUint8(elst.body), n = dv.getUint32(elst.body + 4);
    for (let i = 0, o = elst.body + 8; i < n; i++, o += v ? 20 : 12) {
      const mt = v ? dv.getInt32(o + 8) * 4294967296 + dv.getUint32(o + 12) : dv.getInt32(o + 4);
      if (mt !== -1) { mediaTime = mt; break; }
    }
  }

  const stsd = kid(dv, stbl, 'stsd');
  const codec = stsd ? T4(dv, stsd.body + 12) : '';
  const stsz = kid(dv, stbl, 'stsz'), stts = kid(dv, stbl, 'stts'), stsc = kid(dv, stbl, 'stsc');
  const stco = kid(dv, stbl, 'stco'), co64 = kid(dv, stbl, 'co64');
  if (!stsd || !stsz || !stts || !stsc || !(stco || co64)) return null;

  const n = dv.getUint32(stsz.body + 8), fixed = dv.getUint32(stsz.body + 4);
  if (!n) return null;
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);

  const dur = new Uint32Array(n), dts = new Float64Array(n);
  let s = 0, t = 0;
  for (let e = 0, c = dv.getUint32(stts.body + 4); e < c; e++) {
    const cnt = dv.getUint32(stts.body + 8 + e * 8), d = dv.getUint32(stts.body + 12 + e * 8);
    for (let k = 0; k < cnt && s < n; k++, s++) { dur[s] = d; dts[s] = t; t += d; }
  }
  for (; s < n; s++) { dts[s] = t; }

  let cto = null;
  const ctts = kid(dv, stbl, 'ctts');
  if (ctts) {
    cto = new Int32Array(n); s = 0;
    for (let e = 0, c = dv.getUint32(ctts.body + 4); e < c; e++) {
      const cnt = dv.getUint32(ctts.body + 8 + e * 8), v = dv.getInt32(ctts.body + 12 + e * 8);
      for (let k = 0; k < cnt && s < n; k++) cto[s++] = v;
    }
  }

  let sync = null;
  const stss = kid(dv, stbl, 'stss');
  if (stss) {
    sync = new Uint8Array(n);
    for (let e = 0, c = dv.getUint32(stss.body + 4); e < c; e++) { const i = dv.getUint32(stss.body + 8 + e * 4) - 1; if (i < n) sync[i] = 1; }
  }

  const chunks = [];
  if (co64) for (let e = 0, c = dv.getUint32(co64.body + 4); e < c; e++) chunks.push(U64(dv, co64.body + 8 + e * 8));
  else for (let e = 0, c = dv.getUint32(stco.body + 4); e < c; e++) chunks.push(dv.getUint32(stco.body + 8 + e * 4));
  const off = new Float64Array(n);
  const sc = dv.getUint32(stsc.body + 4);
  s = 0;
  for (let e = 0; e < sc && s < n; e++) {
    const first = dv.getUint32(stsc.body + 8 + e * 12), spc = dv.getUint32(stsc.body + 12 + e * 12);
    const next = e + 1 < sc ? dv.getUint32(stsc.body + 20 + e * 12) : chunks.length + 1;
    for (let c = first; c < next && s < n; c++) {
      let p = chunks[c - 1];
      for (let k = 0; k < spc && s < n; k++) { off[s] = p; p += size[s]; s++; }
    }
  }
  if (s < n) return null;

  return { handler, ts, lang, matrix, width, height, mediaTime, codec, n, size, dur, dts, cto, sync, off,
    hdlr: new Uint8Array(dv.buffer, dv.byteOffset + hdlr.o, hdlr.size).slice(),
    stsd: new Uint8Array(dv.buffer, dv.byteOffset + stsd.o, stsd.size).slice() };
}

// ---------- writing ----------
function u32s(...v) { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0)); return b; }
function i32s(...v) { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setInt32(i * 4, x)); return b; }
function u16s(...v) { const b = new Uint8Array(v.length * 2), d = new DataView(b.buffer); v.forEach((x, i) => d.setUint16(i * 2, x)); return b; }
function box(t, ...parts) {
  let len = 8; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); new DataView(out.buffer).setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
  let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const full = (t, ver, flags, ...parts) => box(t, u32s(((ver << 24) | flags) >>> 0), ...parts);
const IDENTITY = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

function rle(arr, a, b) {
  const out = [];
  for (let i = a; i < b; i++) { const v = arr[i]; const l = out[out.length - 1]; if (l && l[1] === v) l[0]++; else out.push([1, v]); }
  return out;
}

function trakBox(T, a, b, id, mvTs, chunkOff, mediaTime) {
  const n = b - a;
  const mediaDur = T.dts[b - 1] + T.dur[b - 1] - T.dts[a];
  const movDur = Math.round(mediaDur * mvTs / T.ts);
  const tk = new Uint8Array(84), d = new DataView(tk.buffer);
  d.setUint32(0, 3); d.setUint32(12, id); d.setUint32(20, movDur);
  d.setUint16(36, T.handler === 'soun' ? 0x0100 : 0); tk.set(T.matrix, 40); d.setUint32(76, T.width); d.setUint32(80, T.height);
  const parts = [box('tkhd', tk)];
  if (mediaTime > 0) parts.push(box('edts', full('elst', 0, 0, u32s(1, movDur), i32s(mediaTime), u32s(0x10000))));

  const stts = rle(T.dur, a, b);
  const stbl = [T.stsd, full('stts', 0, 0, u32s(stts.length, ...stts.flat()))];
  if (T.cto) {
    const c = rle(T.cto, a, b);
    const neg = c.some((x) => x[1] < 0);
    const body = new Uint8Array(4 + c.length * 8), cd = new DataView(body.buffer);
    cd.setUint32(0, c.length); c.forEach(([cnt, v], i) => { cd.setUint32(4 + i * 8, cnt); cd.setInt32(8 + i * 8, v); });
    stbl.push(full('ctts', neg ? 1 : 0, 0, body));
  }
  if (T.sync) {
    const idx = []; for (let i = a; i < b; i++) if (T.sync[i]) idx.push(i - a + 1);
    stbl.push(full('stss', 0, 0, u32s(idx.length, ...idx)));
  }
  stbl.push(full('stsc', 0, 0, u32s(1, 1, n, 1)));
  const sz = new Uint8Array(8 + n * 4), sd = new DataView(sz.buffer);
  sd.setUint32(0, 0); sd.setUint32(4, n); for (let i = 0; i < n; i++) sd.setUint32(8 + i * 4, T.size[a + i]);
  stbl.push(full('stsz', 0, 0, sz));
  stbl.push(full('stco', 0, 0, u32s(1, chunkOff)));

  const mhd = T.handler === 'soun' ? full('smhd', 0, 0, new Uint8Array(4)) : full('vmhd', 0, 1, new Uint8Array(8));
  const dinf = box('dinf', full('dref', 0, 0, u32s(1), full('url ', 0, 1)));
  const mdia = box('mdia', full('mdhd', 0, 0, u32s(0, 0, T.ts, mediaDur), u16s(T.lang, 0)), T.hdlr, box('minf', mhd, dinf, box('stbl', ...stbl)));
  parts.push(mdia);
  return { box: box('trak', ...parts), movDur };
}

// byte runs of samples [a,b), fetched through read(offset, length) -> Promise<Blob>
async function slices(read, T, a, b) {
  const runs = []; let bytes = 0;
  let s = T.off[a], e = s + T.size[a];
  for (let i = a + 1; i < b; i++) {
    const o = T.off[i];
    if (o === e) e += T.size[i]; else { runs.push([s, e]); bytes += e - s; s = o; e = o + T.size[i]; }
  }
  runs.push([s, e]); bytes += e - s;
  const out = [];
  for (const [x, y] of runs) out.push(await read(x, y - x));
  return { out, bytes };
}

/**
 * Returns null if this file can't take the fast path (then the caller falls back to ffmpeg).
 * Otherwise { videoCodec, ranges:[{duration}], build(k, materialize=false) -> Promise<Blob> }.
 */
export async function prepare(file, opts) {
  const top = await scanTop(file);
  if (!top || top.size > 300 * 1024 * 1024) return null;
  const buf = await file.slice(top.o, top.o + top.size).arrayBuffer();
  return planFromMoov(buf, async (o, l) => file.slice(o, o + l), opts);
}

/**
 * Plan the parts from the movie's index (the moov box bytes) alone. Media bytes are fetched later through
 * read(offset, length) -> Promise<Blob>, so they can come from the picked file or from a copy in browser storage.
 * Each range also says up to which byte of the original file it needs (end).
 */
export function planFromMoov(buf, read, { firstBytes, targetBytes }) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const moov = [...kids(dv, 0, buf.byteLength)][0];
  if (!moov || moov.t !== 'moov' || kid(dv, moov, 'mvex')) return null; // fragmented → fallback
  const mvhd = kid(dv, moov, 'mvhd');
  const mvTs = mvhd ? dv.getUint32(mvhd.body + (dv.getUint8(mvhd.body) ? 20 : 12)) : 1000;
  let V = null, A = null;
  for (const tr of kidsOf(dv, moov, 'trak')) {
    const T = parseTrak(dv, tr);
    if (!T) continue;
    if (T.handler === 'vide' && !V) V = T;
    else if (T.handler === 'soun' && !A) A = T;
  }
  if (!V) return null;
  if (A && !/^(mp4a|\.mp3)$/.test(A.codec)) return null; // AC3/DTS… → ffmpeg converts the audio

  // keyframe groups → greedy plan by size
  const keys = [];
  for (let i = 0; i < V.n; i++) if (!V.sync || V.sync[i]) keys.push(i);
  if (!keys.length || keys[0] !== 0) keys.unshift(0);
  let vBytes = 0; for (let i = 0; i < V.n; i++) vBytes += V.size[i];
  let aBytes = 0; if (A) for (let i = 0; i < A.n; i++) aBytes += A.size[i];
  const scale = (vBytes + aBytes) / Math.max(1, vBytes);
  const cuts = [0];
  let acc = 0;
  for (let g = 0; g < keys.length; g++) {
    const end = g + 1 < keys.length ? keys[g + 1] : V.n;
    let bytes = 0; for (let i = keys[g]; i < end; i++) bytes += V.size[i];
    bytes *= scale;
    const limit = cuts.length === 1 && firstBytes ? firstBytes : targetBytes;
    if (acc > 0 && acc + bytes > limit) { cuts.push(keys[g]); acc = 0; }
    acc += bytes;
  }
  const vr = cuts.map((s, k) => [s, k + 1 < cuts.length ? cuts[k + 1] : V.n]);
  const ptsV = (i) => (V.dts[i] + (V.cto ? V.cto[i] : 0) - V.mediaTime) / V.ts;
  // audio: each sample goes to the part whose video start it falls after (no overlap → gapless)
  const ar = [];
  if (A) {
    let j = 0;
    for (let k = 0; k < vr.length; k++) {
      const until = k + 1 < vr.length ? ptsV(vr[k + 1][0]) : Infinity;
      const s = j;
      while (j < A.n && (A.dts[j] - A.mediaTime) / A.ts < until) j++;
      ar.push([s, j]);
    }
  }
  const lastByte = (T, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, T.off[i] + T.size[i]); return m; };
  const ranges = vr.map(([a, b], k) => ({
    duration: (V.dts[b - 1] + V.dur[b - 1] - V.dts[a]) / V.ts,
    end: Math.max(lastByte(V, a, b), A && ar[k][1] > ar[k][0] ? lastByte(A, ar[k][0], ar[k][1]) : 0),
  }));

  const FTYP = box('ftyp', new TextEncoder().encode('isom'), u32s(0x200), new TextEncoder().encode('isomiso2avc1mp41'));
  async function build(k, materialize = false) {
    const [va, vb] = vr[k];
    const hasA = A && ar[k][1] > ar[k][0];
    const vS = await slices(read, V, va, vb);
    const aS = hasA ? await slices(read, A, ar[k][0], ar[k][1]) : { out: [], bytes: 0 };
    const make = (vOff, aOff) => {
      const tv = trakBox(V, va, vb, 1, mvTs, vOff, V.mediaTime);
      const ta = hasA ? trakBox(A, ar[k][0], ar[k][1], 2, mvTs, aOff, k === 0 ? A.mediaTime : 0) : null;
      const mvhdB = full('mvhd', 0, 0, u32s(0, 0, mvTs, tv.movDur, 0x10000), u16s(0x0100), new Uint8Array(10), IDENTITY, new Uint8Array(24), u32s(3));
      return ta ? box('moov', mvhdB, tv.box, ta.box) : box('moov', mvhdB, tv.box);
    };
    const len = make(0, 0).length;
    const dataStart = FTYP.length + len + 8;
    const moovB = make(dataStart, dataStart + vS.bytes);
    const mdatHdr = u32s(8 + vS.bytes + aS.bytes); const mh = new Uint8Array(8); mh.set(mdatHdr); mh.set([0x6d, 0x64, 0x61, 0x74], 4);
    const lazy = new Blob([FTYP, moovB, mh, ...vS.out, ...aS.out], { type: 'video/mp4' });
    // Keep the part lazy unless a caller (for example Safari persistence) explicitly needs a materialised copy.
    return materialize ? new Blob([await lazy.arrayBuffer()], { type: 'video/mp4' }) : lazy;
  }
  return { videoCodec: V.codec, ranges, build };
}

/**
 * Read the picked file ONCE, front to back (the only fast way on phones — jumping to an offset deep inside a
 * picked file can cost a read of everything before it), handing out fixed-size chunks to store, and spotting the
 * movie's index (moov) on the way. onMoov(Uint8Array) fires as soon as the index has streamed past.
 */
export async function importMp4(file, { chunkBytes, saveChunk, onMoov }) {
  const reader = file.stream().getReader();
  let pos = 0, boxStart = 0, hdr = [], moov = null, moovAt = 0, moovFill = 0, seenMoov = false, bad = false;
  let pend = [], pendLen = 0, idx = 0;
  const flush = async (final) => {
    while (pendLen >= chunkBytes || (final && pendLen > 0)) {
      const take = Math.min(chunkBytes, pendLen), pieces = []; let got = 0;
      while (got < take) {
        const a = pend[0], need = take - got;
        if (a.length <= need) { pieces.push(a); got += a.length; pend.shift(); }
        else { pieces.push(a.subarray(0, need)); pend[0] = a.subarray(need); got += need; }
      }
      pendLen -= take;
      await saveChunk(idx++, new Blob(pieces), (idx) * chunkBytes >= file.size ? file.size : idx * chunkBytes);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const cs = pos, ce = pos + value.length;
    // walk the top-level boxes as the bytes go by
    let c = cs;
    while (c < ce && !bad) {
      if (moov) {
        const n = Math.min(moov.length - moovFill, ce - c);
        moov.set(value.subarray(c - cs, c - cs + n), moovFill); moovFill += n; c += n;
        if (moovFill === moov.length) { const m = moov; moov = null; seenMoov = true; await onMoov(m); }
        continue;
      }
      if (c < boxStart) { c = Math.min(boxStart, ce); continue; }
      const want = Math.min(16, file.size - boxStart) - hdr.length;
      const n = Math.min(want, ce - c);
      for (let i = 0; i < n; i++) hdr.push(value[c - cs + i]);
      c += n;
      if (hdr.length < Math.min(16, file.size - boxStart) && hdr.length < 8) continue;
      const h = new DataView(Uint8Array.from(hdr).buffer);
      let size = h.getUint32(0); const t = T4(h, 4);
      if (size === 1) { if (hdr.length < 16) continue; size = U64(h, 8); } else if (size === 0) size = file.size - boxStart;
      if (size < 8) { bad = true; break; }
      if (t === 'moov' && !seenMoov && size < 300 * 1024 * 1024) {
        moov = new Uint8Array(size); moovAt = boxStart; moovFill = 0;
        const already = Math.min(c - boxStart, size);
        moov.set(Uint8Array.from(hdr).subarray(0, already), 0); moovFill = already;
        c = boxStart + already;
        if (moovFill === size) { const m = moov; moov = null; seenMoov = true; await onMoov(m); }
      }
      boxStart += size; hdr = [];
      if (c > boxStart) { if (boxStart < cs) { bad = true; break; } c = boxStart; }   // tiny box: rescan from its end
    }
    pend.push(value); pendLen += value.length; pos = ce;
    await flush(false);
  }
  await flush(true);
  return { seenMoov, moovAt };
}
