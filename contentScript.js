(function () {
  const STORAGE_KEY = "yt_playback_rate";
  const DEFAULT_RATE = 1;
  const MIN_RATE = 0.1;
  const MAX_RATE = 16;
  const USER_INTENT_WINDOW_MS = 1200;
  const REAPPLY_DELAY_MS = 200;
  const trackedVideos = new WeakSet();

  let desiredRate = DEFAULT_RATE;
  let lastUserIntentAt = 0;
  let reapplyTimer;

  const isPlayerPage = () => {
    const path = location.pathname || "";
    return (
      path.startsWith("/watch") ||
      path.startsWith("/shorts") ||
      path.startsWith("/embed/")
    );
  };

  const normalizeRate = (value) => {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_RATE;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  };

  const loadRate = () =>
    new Promise((resolve) => {
      try {
        chrome.storage?.local.get([STORAGE_KEY], (res) => {
          resolve(normalizeRate(res?.[STORAGE_KEY]));
        });
      } catch (_) {
        resolve(DEFAULT_RATE);
      }
    });

  const saveRate = (rate) => {
    try {
      chrome.storage?.local.set({ [STORAGE_KEY]: normalizeRate(rate) });
    } catch (_) {
      // if storage is not available
    }
  };

  const applyRate = (video) => {
    if (!video || video.playbackRate === desiredRate) return;
    try {
      video.playbackRate = desiredRate;
    } catch (_) {
      // some player states reject writes
    }
  };

  const scheduleReapply = (video) => {
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => applyRate(video), REAPPLY_DELAY_MS);
  };

  const handleRateChange = (video) => {
    const rate = normalizeRate(video.playbackRate);
    if (rate === desiredRate) return;

    const isUserChange = Date.now() - lastUserIntentAt < USER_INTENT_WINDOW_MS;
    if (isUserChange) {
      desiredRate = rate;
      saveRate(rate);
    } else {
      scheduleReapply(video);
    }
  };

  const attach = (video) => {
    if (!video || trackedVideos.has(video)) return;
    trackedVideos.add(video);

    const reapply = () => applyRate(video);
    video.addEventListener("loadedmetadata", reapply, { passive: true });
    video.addEventListener("play", reapply, { passive: true });
    video.addEventListener("ratechange", () => handleRateChange(video), {
      passive: true,
    });

    reapply();
  };

  const scan = () => {
    if (!isPlayerPage()) return;
    document.querySelectorAll("video").forEach((video) => {
      attach(video);
      applyRate(video);
    });
  };

  const listenStorageChanges = () => {
    if (!chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
      desiredRate = normalizeRate(changes[STORAGE_KEY]?.newValue);
      scan();
    });
  };

  const observe = () => {
    const root = document.documentElement;
    if (!root) return;
    const observer = new MutationObserver((mutations) => {
      if (!isPlayerPage()) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.tagName === "VIDEO") {
            attach(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll("video").forEach(attach);
          }
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  };

  const recordUserIntent = (event) => {
    const target = event.target;
    const tag = target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target?.isContentEditable
    ) {
      return;
    }
    lastUserIntentAt = Date.now();
  };

  const listenUserIntent = () => {
    document.addEventListener("keydown", recordUserIntent, true);
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (!target || !target.closest) return;
        if (target.closest("video") || target.closest(".html5-video-player")) {
          recordUserIntent(event);
        }
      },
      true,
    );
  };

  const listenNavigation = () => {
    const onNavigate = () => scan();
    window.addEventListener("yt-navigate-finish", onNavigate, true);
    window.addEventListener("yt-page-data-updated", onNavigate, true);
    window.addEventListener("spfdone", onNavigate, true);
  };

  const init = async () => {
    desiredRate = await loadRate();
    scan();
    observe();
    listenNavigation();
    listenUserIntent();
    listenStorageChanges();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
