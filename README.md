YouTube Playback Speed Persist (YPSP)

What it does
- Persists YouTube playback speed across refreshes and between different videos.
- No UI; all logic runs as a content script.
- Vanilla JS, Chrome Manifest V3.

How to load in Chrome
1. Open `chrome://extensions`.
2. Enable `Developer mode` (top right).
3. Click `Load unpacked` and select this folder (`yt-control`).
4. Navigate to any YouTube video. Change speed using the player control or keyboard shortcuts. The chosen speed will persist across videos and refreshes.

Files
- `manifest.json`: MV3 configuration and content script registration.
- `contentScript.js`: Applies stored playback rate and saves changes on `ratechange`.

Notes
- Runs on `*.youtube.com/*` but only applies on player pages (`/watch`, `/shorts`, `/embed`).
- Uses `chrome.storage.local` to persist the last used playback rate.
