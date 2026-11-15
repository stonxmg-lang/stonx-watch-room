// STONX smart splitter — cuts a big movie into <100MB MP4 parts on keyframes, right in the browser.
// Video is stream-copied (no quality loss, fast). Audio that browsers can't play (AC3, DTS…) is converted to AAC.
import { FFmpeg } from '/vendor/ffmpeg/ffmpeg/index.js';

const MAX_BYTES = 99 * 1024 * 1024;   // Cloudinary free plan: 100MB per video
const TARGET_BYTES = 80 * 1024 * 1024;  // aim lower: bitrate varies inside a range
const DIRECT_EXT = /\.(mp4|m4v)$/i;

let ff = null;
async function getFFmpeg(onStage) {
  if (ff) return ff;
  onStage && onStage('بنجهّز أداة التقسيم (أول مرة بس)…', null);
  ff = new FFmpeg();
  await ff.load({ coreURL: '/vendor/ffmpeg/core/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/core/ffmpeg-core.wasm' });
  return ff;
}

function parseFramecrc(text) {
  const tb = {}, packets = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#tb')) { const m = line.match(/^#tb (\d+): (\d+)\/(\d+)/); if (m) tb[m[1]] = +m[2] / +m[3]; continue; }
    if (!line || line[0] === '#') continue;
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 5) continue;
    const st = f[0];
    packets.push({ st, pts: +f[2] * (tb[st] || 0), dur: +f[3] * (tb[st] || 0), size: +f[4], key: !line.includes('F=') });
  }
  return { tb, packets };
}

async function run(args) {
  const code = await ff.exec(args);
  return code;
}

/**
 * Async generator. Yields { blob, index, trim, duration, total } for each part, in order.
 * onStage(text, ratio) reports progress for the UI.
 */
export async function* splitMovie(file, { onStage = () => {}, confirmCodec = async () => true, targetBytes = TARGET_BYTES, firstBytes = 0, onPlan = null, onFast = null, isDone = null } = {}) {
  if (onPlan) {
    // fast path: plain MP4/MOV → cut in pure JS, no ffmpeg at all
    onStage('بنقرا الفيلم…', null);
    let fast = null;
    try { fast = await (await import('/mp4cut.js')).prepare(file, { firstBytes, targetBytes }); } catch (e) { console.warn('fast cut failed', e); }
    if (fast) {
      if (!/^(avc1|avc3)$/.test(fast.videoCodec)) {
        const ok = await confirmCodec(fast.videoCodec.replace(/^(hvc1|hev1)$/, 'hevc'));
        if (!ok) throw new Error('اتلغى');
      }
      onFast && onFast(fast.build);
      await onPlan(fast.ranges);
      for (let k = 0; k < fast.ranges.length; k++) {
        if (isDone && isDone(k)) continue;
        const blob = await fast.build(k);
        yield { blob, index: k, trim: 0, duration: fast.ranges[k].duration, total: fast.ranges.length };
      }
      return;
    }
  }
  if (!onPlan && file.size <= MAX_BYTES && DIRECT_EXT.test(file.name)) {
    yield { blob: file, index: 0, trim: 0, duration: 0, total: 1 };
    return;
  }

  await getFFmpeg(onStage);
  const logs = [];
  const onLog = ({ message }) => { logs.push(message); if (logs.length > 400) logs.shift(); };
  ff.on('log', onLog);
  try {
    await ff.createDir('/in').catch(() => {});
    await ff.mount('WORKERFS', { files: [file] }, '/in');
    const inPath = '/in/' + file.name;

    // 1) what's inside?
    onStage('بنحلّل الفيلم…', null);
    logs.length = 0;
    await run(['-hide_banner', '-i', inPath]);
    const info = logs.join('\n');
    const dm = info.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = dm ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : 0;
    const vcodec = (info.match(/Stream #\d+:\d+[^:]*: Video: (\w+)/) || [])[1] || '';
    const acodec = (info.match(/Stream #\d+:\d+[^:]*: Audio: (\w+)/) || [])[1] || '';
    if (!vcodec) throw new Error('مش لاقي فيديو جوّه الملف ده');
    if (!/^h264$/.test(vcodec)) {
      const ok = await confirmCodec(vcodec);
      if (!ok) throw new Error('اتلغى');
    }
    const audioArgs = !acodec ? [] : /^(aac|mp3)$/.test(acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];

    // 2) where are the keyframes, and how heavy is each GOP?
    onStage('بندوّر على أماكن القطع المناسبة…', 0);
    const onProg = ({ time }) => { if (duration) onStage('بندوّر على أماكن القطع المناسبة…', Math.min(1, time / 1e6 / duration)); };
    ff.on('progress', onProg);
    await run(['-loglevel', 'error', '-i', inPath, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '/kf.txt']);
    ff.off('progress', onProg);
    const { packets } = parseFramecrc(await ff.readFile('/kf.txt', 'utf8'));
    await ff.deleteFile('/kf.txt').catch(() => {});
    const gops = []; // decode-order groups that start at a keyframe
    let videoBytes = 0;
    for (const p of packets) {
      videoBytes += p.size;
      if (p.key || !gops.length) gops.push({ t: p.pts, bytes: 0 });
      gops[gops.length - 1].bytes += p.size;
    }
    if (!gops.length) throw new Error('مش قادر أقرا الفيديو');
    const end = duration || Math.max(...packets.map((p) => p.pts + p.dur));
    const scale = file.size / Math.max(1, videoBytes); // audio + container overhead

    // 3) greedy plan: cut on keyframes, ~80MB each
    const cuts = [gops[0].t <= 0.5 ? 0 : gops[0].t];
    let acc = 0;
    for (let i = 0; i < gops.length; i++) {
      const est = gops[i].bytes * scale;
      const limit = cuts.length === 1 && firstBytes ? firstBytes : targetBytes; // small first part = fast start
      if (acc > 0 && acc + est > limit) { cuts.push(gops[i].t); acc = 0; }
      acc += est;
    }
    const ranges = cuts.map((s, i) => ({ s, e: i + 1 < cuts.length ? cuts[i + 1] : end }));
    const keyTimes = gops.map((g) => g.t);
    if (onPlan) await onPlan(ranges.map((r) => ({ duration: r.e - r.s })));

    // 4) cut each range; if it still came out too big, split it at the middle keyframe and retry
    let index = 0;
    while (ranges.length) {
      const r = ranges.shift();
      const tot = index + 1 + ranges.length;
      onStage(`بنجهّز الجزء ${index + 1} من ${tot}…`, null);
      const args = [];
      if (r.s > 0) args.push('-ss', (r.s + 0.02).toFixed(3));
      args.push('-i', inPath);
      if (r.e < end) args.push('-t', Math.max(0.1, r.e - r.s - 0.02).toFixed(3));
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'copy', ...audioArgs,
        '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', '/out.mp4');
      logs.length = 0;
      const code = await run(['-loglevel', 'error', ...args]);
      if (code !== 0) throw new Error('فشل تقسيم الجزء ' + (index + 1) + ': ' + logs.slice(-3).join(' '));
      const data = await ff.readFile('/out.mp4');
      if (data.byteLength > MAX_BYTES && !onPlan) {
        const mids = keyTimes.filter((t) => t > r.s + 1 && t < r.e - 1);
        if (mids.length) {
          const m = mids[Math.floor(mids.length / 2)];
          ranges.unshift({ s: r.s, e: m }, { s: m, e: r.e });
          await ff.deleteFile('/out.mp4');
          continue;
        }
      }
      // measure the real start of each stream so the player can skip any duplicated lead-in
      await run(['-loglevel', 'error', '-i', '/out.mp4', '-c', 'copy', '-f', 'framecrc', '/m.txt']);
      const meta = parseFramecrc(await ff.readFile('/m.txt', 'utf8')).packets;
      await ff.deleteFile('/m.txt').catch(() => {});
      await ff.deleteFile('/out.mp4');
      const first = (st) => Math.min(...meta.filter((p) => p.st === st).map((p) => p.pts));
      const last = (st) => Math.max(...meta.filter((p) => p.st === st).map((p) => p.pts + p.dur));
      const hasA = meta.some((p) => p.st === '1');
      const v0 = first('0');
      const a0 = hasA ? first('1') : v0;
      const trim = Math.max(0, a0 - v0);
      const partDur = (hasA ? last('1') - a0 : last('0') - v0) || r.e - r.s;
      yield { blob: new Blob([data.buffer], { type: 'video/mp4' }), index, trim, duration: partDur, total: tot };
      index++;
    }
  } finally {
    ff.off('log', onLog);
    await ff.unmount('/in').catch(() => {});
  }
}
