// Copies ffmpeg.wasm and PeerJS into /public so everything loads from our own origin.
const fs = require('fs'), path = require('path');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

// Optional: a deployment can carry a small deploy-ref.txt instead of whole pages. First line is a commit of the
// public GitHub repo, the other lines are files to take from that commit (e.g. public/room.html).
async function fromGitHub() {
  const ref = path.join(__dirname, 'deploy-ref.txt');
  if (!fs.existsSync(ref)) return;
  const [sha, ...files] = fs.readFileSync(ref, 'utf8').split(/\s+/).filter(Boolean);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('deploy-ref.txt: bad commit ' + sha);
  for (const f of files) {
    if (!/^public\/[\w./-]+$/.test(f) || f.includes('..')) throw new Error('deploy-ref.txt: bad path ' + f);
    const url = `https://raw.githubusercontent.com/stonxmg-lang/stonx-watch-room/${sha}/${f}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(path.join(__dirname, f)), { recursive: true });
    fs.writeFileSync(path.join(__dirname, f), buf);
    console.log('from GitHub', sha.slice(0, 7), f, buf.length, 'bytes');
  }
}

fromGitHub().then(() => {
  copy(path.join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), path.join(__dirname, 'public/vendor/ffmpeg/ffmpeg'));
  copy(path.join(__dirname, 'node_modules/@ffmpeg/core/dist/esm'), path.join(__dirname, 'public/vendor/ffmpeg/core'));
  copy(path.join(__dirname, 'node_modules/peerjs/dist/peerjs.min.js'), path.join(__dirname, 'public/vendor/peerjs.min.js'));
  console.log('vendor copied');
}).catch((e) => { console.error(e); process.exit(1); });
