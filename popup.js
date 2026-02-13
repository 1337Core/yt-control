(() => {
  const STORAGE_KEYS = {
    rate: "yt_playback_rate",
    videoDelayMs: "yt_video_delay_ms",
  };

  const DEFAULT_RATE = 1;
  const MIN_RATE = 0.1;
  const MAX_RATE = 16;

  const DEFAULT_VIDEO_DELAY_MS = 0;
  const MIN_VIDEO_DELAY_MS = 0;
  const MAX_VIDEO_DELAY_MS = 2500;

  const STATUS_MS = 1800;

  const CAL_ONE_WAY_MS = 1500;
  const CAL_PERIOD_MS = CAL_ONE_WAY_MS * 2;
  const CAL_FIRST_CENTER_MS = CAL_ONE_WAY_MS / 2;
  const CAL_CENTER_INTERVAL_MS = CAL_ONE_WAY_MS;

  const rateInput = document.getElementById("rateInput");
  const applyBtn = document.getElementById("applyBtn");
  const resetBtn = document.getElementById("resetBtn");
  const delayInput = document.getElementById("delayInput");
  const delayApplyBtn = document.getElementById("delayApplyBtn");
  const delayResetBtn = document.getElementById("delayResetBtn");

  const calibrateBtn = document.getElementById("calibrateBtn");
  const calibrationPanel = document.getElementById("calibrationPanel");
  const calibrationCanvas = document.getElementById("calibrationCanvas");
  const calibrationStepEl = document.getElementById("calibrationStep");
  const calibrationOffsetRange = document.getElementById("calibrationOffsetRange");
  const calibrationValueEl = document.getElementById("calibrationValue");
  const calibrationNudgeDownBtn = document.getElementById("calibrationNudgeDownBtn");
  const calibrationNudgeUpBtn = document.getElementById("calibrationNudgeUpBtn");
  const calibrationResetPreviewBtn = document.getElementById("calibrationResetPreviewBtn");
  const calibrationApplyBtn = document.getElementById("calibrationApplyBtn");

  const statusEl = document.getElementById("status");

  let statusTimer;

  const calibrationState = {
    active: false,
    startAtMs: 0,
    frameId: 0,
    lastAudioCrossingIndex: -1,
    previewOffsetMs: DEFAULT_VIDEO_DELAY_MS,
    savedDelayMs: DEFAULT_VIDEO_DELAY_MS,
    audioContext: null,
  };

  const normalizeRate = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RATE;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, parsed));
  };

  const normalizeDelay = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_VIDEO_DELAY_MS;
    return Math.round(
      Math.min(MAX_VIDEO_DELAY_MS, Math.max(MIN_VIDEO_DELAY_MS, parsed)),
    );
  };

  const toDisplayRate = (value) => {
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  };

  const toDisplayDelay = (value) => String(normalizeDelay(value));

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, STATUS_MS);
  };

  const readStoredSettings = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(
        [STORAGE_KEYS.rate, STORAGE_KEYS.videoDelayMs],
        (res) => {
          resolve({
            rate: normalizeRate(res?.[STORAGE_KEYS.rate]),
            delayMs: normalizeDelay(res?.[STORAGE_KEYS.videoDelayMs]),
          });
        },
      );
    });

  const writeRate = (value, source) => {
    const normalized = normalizeRate(value);
    chrome.storage.local.set({ [STORAGE_KEYS.rate]: normalized }, () => {
      if (rateInput) {
        rateInput.value = toDisplayRate(normalized);
      }
      setStatus(`${source} ${toDisplayRate(normalized)}x`);
    });
  };

  const writeDelay = (value, source) => {
    const normalized = normalizeDelay(value);
    chrome.storage.local.set({ [STORAGE_KEYS.videoDelayMs]: normalized }, () => {
      if (delayInput) {
        delayInput.value = toDisplayDelay(normalized);
      }

      calibrationState.savedDelayMs = normalized;
      if (!calibrationState.active) {
        setCalibrationPreviewDelay(normalized);
      }

      setStatus(`${source} ${toDisplayDelay(normalized)} ms`);
    });
  };

  const ensureCalibrationAudioContext = () => {
    const ContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!ContextCtor) return null;

    if (
      !calibrationState.audioContext ||
      calibrationState.audioContext.state === "closed"
    ) {
      calibrationState.audioContext = new ContextCtor();
    }

    return calibrationState.audioContext;
  };

  const playCalibrationClick = async () => {
    const context = ensureCalibrationAudioContext();
    if (!context) return;

    if (context.state === "suspended") {
      await context.resume().catch(() => {
        // browser may still block until another gesture
      });
    }

    try {
      const now = context.currentTime + 0.01;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(1700, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(now);
      oscillator.stop(now + 0.055);
    } catch (_) {
      // ignore click synthesis failures
    }
  };

  const getSweepProgress = (timeMs) => {
    const loopMs = ((timeMs % CAL_PERIOD_MS) + CAL_PERIOD_MS) % CAL_PERIOD_MS;
    if (loopMs <= CAL_ONE_WAY_MS) {
      return loopMs / CAL_ONE_WAY_MS;
    }
    return 1 - (loopMs - CAL_ONE_WAY_MS) / CAL_ONE_WAY_MS;
  };

  const getCrossingIndex = (timeMs) => {
    const first = calibrationState.startAtMs + CAL_FIRST_CENTER_MS;
    if (timeMs < first) return -1;
    return Math.floor((timeMs - first) / CAL_CENTER_INTERVAL_MS);
  };

  const drawCalibration = (nowMs) => {
    if (!calibrationCanvas) return;
    const ctx = calibrationCanvas.getContext("2d");
    if (!ctx) return;

    const width = calibrationCanvas.width;
    const height = calibrationCanvas.height;
    const pad = 14;
    const centerX = width / 2;
    const lineY = Math.round(height * 0.6);

    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, lineY);
    ctx.lineTo(width - pad, lineY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(233, 95, 95, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, lineY - 23);
    ctx.lineTo(centerX, lineY + 23);
    ctx.stroke();

    const adjustedTime = nowMs - calibrationState.previewOffsetMs;
    const progress = getSweepProgress(adjustedTime - calibrationState.startAtMs);
    const x = pad + progress * (width - pad * 2);

    ctx.fillStyle = "#f6f8ff";
    ctx.beginPath();
    ctx.arc(x, lineY, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("center", centerX, lineY - 29);
  };

  const tickCalibration = (nowMs) => {
    if (!calibrationState.active) return;

    const crossingIndex = getCrossingIndex(nowMs);
    if (crossingIndex > calibrationState.lastAudioCrossingIndex) {
      calibrationState.lastAudioCrossingIndex = crossingIndex;
      playCalibrationClick();
    }

    drawCalibration(nowMs);
    calibrationState.frameId = requestAnimationFrame(tickCalibration);
  };

  const updateCalibrationUi = () => {
    if (!calibrationPanel) return;

    if (calibrationStepEl) {
      calibrationStepEl.textContent =
        "Move the slider until click and center crossing feel simultaneous.";
    }

    if (calibrationValueEl) {
      calibrationValueEl.textContent = `Preview delay: ${toDisplayDelay(calibrationState.previewOffsetMs)} ms`;
    }

    if (calibrationOffsetRange) {
      calibrationOffsetRange.value = toDisplayDelay(calibrationState.previewOffsetMs);
    }

    if (calibrationState.active) {
      calibrationPanel.hidden = false;
      if (calibrateBtn) calibrateBtn.textContent = "Stop Popup Calibration";
    } else {
      calibrationPanel.hidden = true;
      if (calibrateBtn) calibrateBtn.textContent = "Start Popup Calibration";
    }
  };

  function setCalibrationPreviewDelay(value) {
    calibrationState.previewOffsetMs = normalizeDelay(value);
    updateCalibrationUi();
  }

  const startCalibration = () => {
    calibrationState.active = true;
    calibrationState.startAtMs = performance.now();
    calibrationState.lastAudioCrossingIndex = getCrossingIndex(
      calibrationState.startAtMs,
    );

    const context = ensureCalibrationAudioContext();
    if (context?.state === "suspended") {
      context.resume().catch(() => {
        // browser may still block until another gesture
      });
    }

    if (calibrationState.frameId) {
      cancelAnimationFrame(calibrationState.frameId);
    }
    calibrationState.frameId = requestAnimationFrame(tickCalibration);

    updateCalibrationUi();
  };

  const stopCalibration = () => {
    calibrationState.active = false;
    if (calibrationState.frameId) {
      cancelAnimationFrame(calibrationState.frameId);
    }
    calibrationState.frameId = 0;
    updateCalibrationUi();
  };

  const toggleCalibration = () => {
    if (calibrationState.active) {
      stopCalibration();
      return;
    }

    const seed = normalizeDelay(delayInput?.value ?? calibrationState.savedDelayMs);
    setCalibrationPreviewDelay(seed);
    startCalibration();
  };

  const nudgeCalibration = (deltaMs) => {
    setCalibrationPreviewDelay(calibrationState.previewOffsetMs + deltaMs);
  };

  const applyCalibrationDelay = () => {
    writeDelay(calibrationState.previewOffsetMs, "Calibrated to");
  };

  const applySpeedInput = () => {
    if (!rateInput) return;
    writeRate(rateInput.value, "Speed set to");
  };

  const applyDelayInput = () => {
    if (!delayInput) return;
    writeDelay(delayInput.value, "Delay set to");
  };

  const init = async () => {
    const current = await readStoredSettings();
    calibrationState.savedDelayMs = current.delayMs;

    if (rateInput) {
      rateInput.value = toDisplayRate(current.rate);
    }
    if (delayInput) {
      delayInput.value = toDisplayDelay(current.delayMs);
    }

    setCalibrationPreviewDelay(current.delayMs);

    applyBtn?.addEventListener("click", applySpeedInput);
    rateInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applySpeedInput();
    });

    resetBtn?.addEventListener("click", () =>
      writeRate(DEFAULT_RATE, "Speed reset to"),
    );

    delayApplyBtn?.addEventListener("click", applyDelayInput);
    delayInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyDelayInput();
    });

    delayResetBtn?.addEventListener("click", () =>
      writeDelay(DEFAULT_VIDEO_DELAY_MS, "Delay reset to"),
    );

    calibrateBtn?.addEventListener("click", toggleCalibration);

    calibrationOffsetRange?.addEventListener("input", () => {
      setCalibrationPreviewDelay(calibrationOffsetRange.value);
    });

    calibrationNudgeDownBtn?.addEventListener("click", () => nudgeCalibration(-10));
    calibrationNudgeUpBtn?.addEventListener("click", () => nudgeCalibration(10));

    calibrationResetPreviewBtn?.addEventListener("click", () => {
      setCalibrationPreviewDelay(calibrationState.savedDelayMs);
    });

    calibrationApplyBtn?.addEventListener("click", applyCalibrationDelay);

    document.querySelectorAll("button[data-rate]").forEach((button) => {
      button.addEventListener("click", () => {
        writeRate(button.dataset.rate, "Speed set to");
      });
    });

    document.querySelectorAll("button[data-delay]").forEach((button) => {
      button.addEventListener("click", () => {
        writeDelay(button.dataset.delay, "Delay set to");
      });
    });

    updateCalibrationUi();
  };

  init();
})();
