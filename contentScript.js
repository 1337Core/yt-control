// Persist and enforce YouTube playback speed across refreshes and videos.
// MV3 content script, vanilla JS, no UI.

(function () {
  const STORAGE_KEY = 'yt_playback_rate';
  const DEFAULT_RATE = 1;
  const trackedVideos = new WeakSet();

  const state = {
    desiredRate: DEFAULT_RATE,
    scanScheduled: false,
  };

  function isPlayerPage() {
    const path = location.pathname || '';
    return path.startsWith('/watch') || path.startsWith('/shorts') || path.startsWith('/embed/');
  }

  function normalizeRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_RATE;
  }

  function loadRate() {
    return new Promise((resolve) => {
      try {
        chrome.storage?.local.get([STORAGE_KEY], (res) => {
          resolve(normalizeRate(res?.[STORAGE_KEY]));
        });
      } catch (_) {
        resolve(DEFAULT_RATE);
      }
    });
  }

  function saveRate(rate) {
    try {
      chrome.storage?.local.set({ [STORAGE_KEY]: rate });
    } catch (_) {
      // Storage can be unavailable in some contexts.
    }
  }

  function applyRate(video) {
    if (!video) return;
    if (video.playbackRate === state.desiredRate) return;
    try {
      video.playbackRate = state.desiredRate;
    } catch (_) {
      // Some player states reject writes; retry on the next lifecycle event.
    }
  }

  function handleRateChange(video) {
    const rate = normalizeRate(video.playbackRate);
    if (rate === state.desiredRate) return;
    state.desiredRate = rate;
    saveRate(rate);
  }

  function attachToVideo(video) {
    if (!video || trackedVideos.has(video)) return;
    trackedVideos.add(video);

    const reapply = () => applyRate(video);
    video.addEventListener('loadedmetadata', reapply, { passive: true });
    video.addEventListener('loadeddata', reapply, { passive: true });
    video.addEventListener('emptied', reapply, { passive: true });
    video.addEventListener('ratechange', () => handleRateChange(video), { passive: true });

    reapply();
  }

  function scanForVideos() {
    state.scanScheduled = false;
    if (!isPlayerPage()) return;
    document.querySelectorAll('video').forEach(attachToVideo);
  }

  function scheduleScan() {
    if (state.scanScheduled) return;
    state.scanScheduled = true;
    requestAnimationFrame(scanForVideos);
  }

  function observeVideos() {
    const root = document.documentElement || document.body;
    if (!root) return;
    const observer = new MutationObserver((mutations) => {
      if (!isPlayerPage()) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName === 'VIDEO') {
            attachToVideo(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(attachToVideo);
          }
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function setupNavigationHooks() {
    const onNavigate = () => {
      if (!isPlayerPage()) return;
      scheduleScan();
      document.querySelectorAll('video').forEach(applyRate);
    };
    window.addEventListener('yt-navigate-finish', onNavigate, true);
    window.addEventListener('yt-page-data-updated', onNavigate, true);
    window.addEventListener('spfdone', onNavigate, true);
  }

  async function init() {
    state.desiredRate = await loadRate();
    scheduleScan();
    observeVideos();
    setupNavigationHooks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
