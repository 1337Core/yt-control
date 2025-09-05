// Persist and enforce YouTube playback speed across refreshes and videos
// MV3 content script, vanilla JS, no UI

(function () {
  const STORAGE_KEY = 'yt_playback_rate';
  let desiredRate = 1;
  const seenVideos = new WeakSet();

  const isPlayerPage = () => {
    const p = location.pathname || '';
    return p.startsWith('/watch') || p.startsWith('/shorts') || p.startsWith('/embed/');
  };

  function loadRate() {
    return new Promise((resolve) => {
      try {
        chrome.storage?.local.get([STORAGE_KEY], (res) => {
          const r = Number(res?.[STORAGE_KEY]);
          resolve(Number.isFinite(r) && r > 0 ? r : 1);
        });
      } catch (_) {
        resolve(1);
      }
    });
  }

  function saveRate(rate) {
    try {
      chrome.storage?.local.set({ [STORAGE_KEY]: rate });
    } catch (_) {
      // no-op if storage is unavailable
    }
  }

  function applyRate(video, rate) {
    if (!video) return;
    if (video.playbackRate !== rate) {
      try {
        video.playbackRate = rate;
      } catch (_) {
        // Some states may reject; ignore and retry on next lifecycle event
      }
    }
  }

  function attachToVideo(video) {
    if (!video || seenVideos.has(video)) return;
    seenVideos.add(video);

    // Re-apply when the source/metadata loads or changes
    const reapply = () => applyRate(video, desiredRate);
    video.addEventListener('loadedmetadata', reapply, { passive: true });
    video.addEventListener('loadeddata', reapply, { passive: true });
    video.addEventListener('emptied', reapply, { passive: true });

    // Persist when user changes speed via UI/shortcuts
    video.addEventListener('ratechange', () => {
      const r = Number(video.playbackRate);
      if (Number.isFinite(r) && r > 0 && r !== desiredRate) {
        desiredRate = r;
        saveRate(desiredRate);
      }
    }, { passive: true });

    // Initial apply
    reapply();
  }

  function scanAndAttach() {
    // Only act on player pages to avoid touching preview thumbnails, etc.
    if (!isPlayerPage()) return;
    document.querySelectorAll('video').forEach(attachToVideo);
  }

  function observeVideos() {
    const obs = new MutationObserver((mutations) => {
      if (!isPlayerPage()) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node && node.nodeType === 1) {
            if (node.tagName === 'VIDEO') {
              attachToVideo(node);
            } else {
              const vids = node.querySelectorAll?.('video');
              vids && vids.forEach(attachToVideo);
            }
          }
        }
      }
    });
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function setupNavigationHooks() {
    // YouTube SPA navigation events
    const reapplyAll = () => {
      if (!isPlayerPage()) return;
      document.querySelectorAll('video').forEach((v) => applyRate(v, desiredRate));
    };
    window.addEventListener('yt-navigate-finish', reapplyAll, true);
    window.addEventListener('spfdone', reapplyAll, true); // legacy fallback
  }

  async function init() {
    desiredRate = await loadRate();
    scanAndAttach();
    observeVideos();
    setupNavigationHooks();
  }

  // Kick off after DOM is ready enough
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

