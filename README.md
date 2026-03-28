yt control

Plasmo-based browser extension that remembers your YouTube speed, supports
custom playback rates above 2x, and adds video delay to match Bluetooth audio
latency.

## develop

1. `bun install`
2. `bun run dev`
3. open `chrome://extensions`
4. turn on developer mode
5. click load unpacked
6. select `build/chrome-mv3-dev`

## build

1. `bun run build`
2. load `build/chrome-mv3-prod` as an unpacked extension

## use

1. open a YouTube video page
2. click the extension icon
3. set playback speed
4. set Bluetooth video delay in milliseconds
5. optional: choose the mic source from `Mic`, then click `Auto` to estimate
   delay from speaker output. Keep the popup open, allow mic access, and keep
   the selected mic near the speaker until calibration finishes.
6. optional fallback: click `Manual` and use the manual sweep preview if auto
   calibration cannot detect a stable result
