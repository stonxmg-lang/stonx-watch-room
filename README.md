# STONX Watch Room 🎬

<p align="center">
  <img src="public/icon.png" width="128" height="128" alt="STONX Watch Room Logo" style="border-radius: 28px;">
</p>

A two-person watch-together room: both people see the same frame at the same second, from anywhere, with no video server in between.

Live: https://stonx-watch-room.vercel.app

## How it works

- **Peer to peer.** PeerJS's free broker only introduces the two browsers. Controls, clock sync and the movie itself flow directly between them over WebRTC.
- **Instant MP4 cutting (`public/mp4cut.js`).** The picked MP4 is cut into small parts in pure JS: the movie index is read once, and each part is rebuilt from byte slices of the original file. There is no re-encoding and no quality loss. A 2-hour, 4.6GB film is cut in seconds, and any part can be built on demand, so seeking ahead works right away.
- **ffmpeg.wasm fallback (`public/split.js`).** Used for non-MP4 files (MKV) and for audio browsers can't play (AC3/DTS → AAC).
- **Fast start.** The first part is tiny (~3MB), so playback starts in seconds. The receiver keeps downloading the whole film in the background into IndexedDB, so refreshes cost nothing.
- **Sync.** The room state is owned by one side. Clock offset is measured NTP-style, and playback is modelled as `base + elapsed`. If either side runs dry, both pause and resume together.
- **Two people only.** A third visitor is turned away.

## Files

| File | What it is |
| --- | --- |
| `public/index.html` | Landing page: create or join a room |
| `public/room.html` | The whole room app (UI, P2P, sync, player) |
| `public/mp4cut.js` | Fast pure-JS MP4 splitter |
| `public/split.js` | Splitting entry point + ffmpeg.wasm fallback |
| `build.js` | Copies ffmpeg.wasm and PeerJS into `public/vendor` at build time |
| `vercel.json` | Static hosting config (`/r/:id` → room) |

## Run / deploy

```bash
npm install
npm run build        # fills public/vendor
npx serve public     # or deploy to Vercel (output dir: public)
```

There are no backend functions and no environment variables.
