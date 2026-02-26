(function () {
  const STORAGE_KEYS = {
    rate: "yt_control_playback_rate",
    videoDelayMs: "yt_control_video_delay_ms",
  };

  const DEFAULT_RATE = 1;
  const MIN_RATE = 0.1;
  const MAX_RATE = 8;

  const DEFAULT_VIDEO_DELAY_MS = 0;
  const MIN_VIDEO_DELAY_MS = 0;
  const MAX_VIDEO_DELAY_MS = 2500;

  const USER_INTENT_WINDOW_MS = 1200;
  const REAPPLY_DELAY_MS = 200;

  const trackedVideos = new WeakSet();
  const delayedRenderers = new WeakMap();

  let desiredRate = DEFAULT_RATE;
  let desiredVideoDelayMs = DEFAULT_VIDEO_DELAY_MS;
  let lastUserIntentAt = 0;
  let reapplyTimer;

  const hasOwn = (object, key) =>
    Boolean(object && Object.prototype.hasOwnProperty.call(object, key));

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

  const normalizeVideoDelay = (value) => {
    const delay = Number(value);
    if (!Number.isFinite(delay)) return DEFAULT_VIDEO_DELAY_MS;
    return Math.min(MAX_VIDEO_DELAY_MS, Math.max(MIN_VIDEO_DELAY_MS, delay));
  };

  const loadSettings = () =>
    new Promise((resolve) => {
      try {
        chrome.storage?.local.get(
          [STORAGE_KEYS.rate, STORAGE_KEYS.videoDelayMs],
          (res) => {
            resolve({
              rate: normalizeRate(res?.[STORAGE_KEYS.rate]),
              videoDelayMs: normalizeVideoDelay(res?.[STORAGE_KEYS.videoDelayMs]),
            });
          },
        );
      } catch (_) {
        resolve({
          rate: DEFAULT_RATE,
          videoDelayMs: DEFAULT_VIDEO_DELAY_MS,
        });
      }
    });

  const saveRate = (rate) => {
    try {
      chrome.storage?.local.set({ [STORAGE_KEYS.rate]: normalizeRate(rate) });
    } catch (_) {
      // storage may be unavailable in rare contexts
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

  class DelayedVideoRenderer {
    constructor(video) {
      this.video = video;
      this.delayMs = DEFAULT_VIDEO_DELAY_MS;
      this.enabled = false;

      this.canvas = null;
      this.ctx = null;
      this.parent = null;

      this.frameQueue = [];
      this.currentFrame = null;
      this.captureInFlight = false;
      this.captureFailures = 0;

      this.videoFrameRequestId = null;
      this.renderRequestId = null;
      this.fallbackCaptureInterval = null;
      this.layoutInterval = null;
      this.resizeObserver = null;

      this.originalVideoOpacity = "";
      this.originalVideoVisibility = "";
      this.originalParentPosition = "";
      this.parentPositionAdjusted = false;
      this.videoHidden = false;

      this.onVideoFrame = this.onVideoFrame.bind(this);
      this.onRenderFrame = this.onRenderFrame.bind(this);
      this.onTimelineMutation = this.onTimelineMutation.bind(this);
      this.onLayoutChange = this.onLayoutChange.bind(this);
    }

    setDelay(delayMs) {
      const nextDelay = normalizeVideoDelay(delayMs);
      if (nextDelay === this.delayMs && (nextDelay === 0 || this.enabled)) return;

      const hasChanged = nextDelay !== this.delayMs;
      this.delayMs = nextDelay;

      if (this.delayMs <= 0) {
        this.disable();
        return;
      }

      this.enable();
      if (hasChanged) {
        this.clearFrames();
      }
    }

    enable() {
      if (this.enabled) return;
      if (!this.video || !this.video.isConnected || !this.video.parentElement) return;

      this.parent = this.video.parentElement;
      const parentStyle = window.getComputedStyle(this.parent);
      this.originalParentPosition = this.parent.style.position;
      if (parentStyle.position === "static") {
        this.parent.style.position = "relative";
        this.parentPositionAdjusted = true;
      }

      this.ensureCanvas();
      this.insertCanvas();
      this.syncCanvasLayout();

      this.originalVideoOpacity = this.video.style.opacity;
      this.originalVideoVisibility = this.video.style.visibility;
      this.setVideoHidden(false);

      this.video.addEventListener("seeking", this.onTimelineMutation, {
        passive: true,
      });
      this.video.addEventListener("ratechange", this.onTimelineMutation, {
        passive: true,
      });
      this.video.addEventListener("loadedmetadata", this.onTimelineMutation, {
        passive: true,
      });
      this.video.addEventListener("emptied", this.onTimelineMutation, {
        passive: true,
      });

      this.resizeObserver = new ResizeObserver(this.onLayoutChange);
      this.resizeObserver.observe(this.video);
      this.resizeObserver.observe(this.parent);
      this.layoutInterval = window.setInterval(this.onLayoutChange, 500);

      this.enabled = true;
      this.requestVideoFrames();
      this.renderRequestId = requestAnimationFrame(this.onRenderFrame);
    }

    disable() {
      if (!this.enabled && !this.canvas) return;
      this.enabled = false;

      if (
        this.videoFrameRequestId != null &&
        typeof this.video.cancelVideoFrameCallback === "function"
      ) {
        this.video.cancelVideoFrameCallback(this.videoFrameRequestId);
      }
      this.videoFrameRequestId = null;

      if (this.renderRequestId != null) {
        cancelAnimationFrame(this.renderRequestId);
      }
      this.renderRequestId = null;

      if (this.fallbackCaptureInterval != null) {
        clearInterval(this.fallbackCaptureInterval);
      }
      this.fallbackCaptureInterval = null;

      if (this.layoutInterval != null) {
        clearInterval(this.layoutInterval);
      }
      this.layoutInterval = null;

      this.resizeObserver?.disconnect();
      this.resizeObserver = null;

      this.video.removeEventListener("seeking", this.onTimelineMutation);
      this.video.removeEventListener("ratechange", this.onTimelineMutation);
      this.video.removeEventListener("loadedmetadata", this.onTimelineMutation);
      this.video.removeEventListener("emptied", this.onTimelineMutation);

      this.clearFrames();

      if (this.canvas?.parentElement) {
        this.canvas.parentElement.removeChild(this.canvas);
      }

      this.setVideoHidden(false);

      if (this.parent && this.parentPositionAdjusted) {
        this.parent.style.position = this.originalParentPosition;
      }

      this.parentPositionAdjusted = false;
      this.parent = null;
    }

    ensureCanvas() {
      if (this.canvas) return;

      this.canvas = document.createElement("canvas");
      this.canvas.className = "yt-control-delay-canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
        pointerEvents: "none",
      });

      this.ctx =
        this.canvas.getContext("2d", {
          alpha: false,
          desynchronized: true,
        }) || this.canvas.getContext("2d");
    }

    insertCanvas() {
      if (!this.canvas || !this.video.parentElement) return;
      if (this.canvas.parentElement === this.video.parentElement) return;
      this.video.insertAdjacentElement("afterend", this.canvas);
    }

    onLayoutChange() {
      this.syncCanvasLayout();
    }

    syncCanvasLayout() {
      if (!this.canvas || !this.video.isConnected) return;

      const width = Math.max(1, this.video.clientWidth || 0);
      const height = Math.max(1, this.video.clientHeight || 0);

      this.canvas.style.left = `${this.video.offsetLeft || 0}px`;
      this.canvas.style.top = `${this.video.offsetTop || 0}px`;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;

      const dpr = window.devicePixelRatio || 1;
      const backingWidth = Math.max(1, Math.round(width * dpr));
      const backingHeight = Math.max(1, Math.round(height * dpr));

      if (
        this.canvas.width !== backingWidth ||
        this.canvas.height !== backingHeight
      ) {
        this.canvas.width = backingWidth;
        this.canvas.height = backingHeight;
      }
    }

    requestVideoFrames() {
      if (!this.enabled) return;

      if (typeof this.video.requestVideoFrameCallback === "function") {
        this.videoFrameRequestId = this.video.requestVideoFrameCallback(
          this.onVideoFrame,
        );
      } else {
        this.fallbackCaptureInterval = window.setInterval(() => {
          this.captureFrame(performance.now());
        }, 33);
      }
    }

    onVideoFrame(now) {
      if (!this.enabled) return;
      this.captureFrame(now);
      this.requestVideoFrames();
    }

    captureFrame(capturedAt) {
      if (!this.enabled || this.captureInFlight) return;
      if (!this.video.isConnected || this.video.readyState < 2) return;
      if (typeof createImageBitmap !== "function") return;

      this.captureInFlight = true;
      createImageBitmap(this.video)
        .then((bitmap) => {
          if (!this.enabled) {
            bitmap.close();
            return;
          }

          this.captureFailures = 0;
          this.frameQueue.push({
            bitmap,
            readyAt: capturedAt + this.delayMs,
          });

          this.trimFrameQueue();
        })
        .catch(() => {
          this.captureFailures += 1;
          if (this.captureFailures >= 16) {
            this.disable();
          }
        })
        .finally(() => {
          this.captureInFlight = false;
        });
    }

    trimFrameQueue() {
      const maxFrames = Math.max(
        10,
        Math.min(180, Math.ceil(this.delayMs / 16) + 10),
      );
      while (this.frameQueue.length > maxFrames) {
        const dropped = this.frameQueue.shift();
        dropped?.bitmap?.close();
      }
    }

    onRenderFrame() {
      if (!this.enabled) return;
      if (!this.video.isConnected) {
        this.disable();
        return;
      }

      const now = performance.now();
      let nextFrame = null;
      while (this.frameQueue.length && this.frameQueue[0].readyAt <= now) {
        nextFrame = this.frameQueue.shift();
      }

      if (nextFrame) {
        this.currentFrame?.bitmap?.close();
        this.currentFrame = nextFrame;
      }

      if (this.currentFrame && this.ctx && this.canvas) {
        this.setVideoHidden(true);
        try {
          this.ctx.drawImage(
            this.currentFrame.bitmap,
            0,
            0,
            this.canvas.width,
            this.canvas.height,
          );
        } catch (_) {
          // drawing can fail during renderer teardown
        }
      } else {
        this.setVideoHidden(false);
      }

      this.renderRequestId = requestAnimationFrame(this.onRenderFrame);
    }

    onTimelineMutation() {
      this.clearFrames();
    }

    clearFrames() {
      for (const frame of this.frameQueue) {
        frame?.bitmap?.close();
      }
      this.frameQueue.length = 0;

      this.currentFrame?.bitmap?.close();
      this.currentFrame = null;

      if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }

      this.setVideoHidden(false);
    }

    setVideoHidden(hidden) {
      if (!this.video) return;
      if (hidden === this.videoHidden) return;
      this.videoHidden = hidden;

      if (hidden) {
        this.video.style.opacity = "0";
        this.video.style.visibility = "visible";
        return;
      }

      this.video.style.opacity = this.originalVideoOpacity;
      this.video.style.visibility = this.originalVideoVisibility;
    }
  }

  const getRenderer = (video) => {
    let renderer = delayedRenderers.get(video);
    if (!renderer) {
      renderer = new DelayedVideoRenderer(video);
      delayedRenderers.set(video, renderer);
    }
    return renderer;
  };

  const applyVideoDelay = (video) => {
    const renderer = getRenderer(video);
    renderer.setDelay(desiredVideoDelayMs);
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
    applyVideoDelay(video);
  };

  const scan = () => {
    if (!isPlayerPage()) return;
    document.querySelectorAll("video").forEach((video) => {
      attach(video);
      applyRate(video);
      applyVideoDelay(video);
    });
  };

  const listenStorageChanges = () => {
    if (!chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      let shouldRescan = false;

      if (hasOwn(changes, STORAGE_KEYS.rate)) {
        desiredRate = normalizeRate(changes[STORAGE_KEYS.rate]?.newValue);
        shouldRescan = true;
      }

      if (hasOwn(changes, STORAGE_KEYS.videoDelayMs)) {
        desiredVideoDelayMs = normalizeVideoDelay(
          changes[STORAGE_KEYS.videoDelayMs]?.newValue,
        );
        shouldRescan = true;
      }

      if (shouldRescan) {
        scan();
      }
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
    const settings = await loadSettings();
    desiredRate = settings.rate;
    desiredVideoDelayMs = settings.videoDelayMs;

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
