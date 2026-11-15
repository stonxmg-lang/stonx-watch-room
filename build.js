// Copies ffmpeg.wasm and PeerJS into /public so everything loads from our own origin.
const fs = require('fs'), path = require('path');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
copy(path.join(__dirname, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), path.join(__dirname, 'public/vendor/ffmpeg/ffmpeg'));
copy(path.join(__dirname, 'node_modules/@ffmpeg/core/dist/esm'), path.join(__dirname, 'public/vendor/ffmpeg/core'));
copy(path.join(__dirname, 'node_modules/peerjs/dist/peerjs.min.js'), path.join(__dirname, 'public/vendor/peerjs.min.js'));
console.log('vendor copied');
