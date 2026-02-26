(() => {
  const STORAGE_KEYS = {
    rate: "yt_playback_rate",
    videoDelayMs: "yt_video_delay_ms",
    micDeviceId: "yt_mic_device_id",
    delayPresets: "yt_delay_presets",
  };

  const DEFAULT_RATE = 1;
  const MIN_RATE = 0.1;
  const MAX_RATE = 8;

  const DEFAULT_VIDEO_DELAY_MS = 0;
  const MIN_VIDEO_DELAY_MS = 0;
  const MAX_VIDEO_DELAY_MS = 2500;
  const MAX_DELAY_PRESETS = 8;
  const MAX_DELAY_PRESET_NAME_CHARS = 24;

  const STATUS_MS = 1800;
  const SLIDER_WRITE_DEBOUNCE_MS = 120;

  const CAL_ONE_WAY_MS = 1500;
  const CAL_PERIOD_MS = CAL_ONE_WAY_MS * 2;
  const CAL_FIRST_CENTER_MS = CAL_ONE_WAY_MS / 2;
  const CAL_CENTER_INTERVAL_MS = CAL_ONE_WAY_MS;
  const CAL_CLICK_SCHEDULE_LEAD_MS = 10;
  const CAL_CANVAS_PAD = 14;

  const AUTO_CAL_TONE_HZ = 1700;
  const AUTO_CAL_TONE_DURATION_MS = 55;
  const AUTO_CAL_PULSE_COUNT = 12;
  const AUTO_CAL_PULSE_INTERVAL_MS = 360;
  const AUTO_CAL_START_LEAD_MS = 380;
  const AUTO_CAL_CAPTURE_TAIL_MS = 700;
  const AUTO_CAL_MIN_RISE_DB = 11;
  const AUTO_CAL_MIN_PEAK_DB = -70;
  const AUTO_CAL_MIN_LAG_MS = 20;
  const AUTO_CAL_MAX_LAG_MS = MAX_VIDEO_DELAY_MS;
  const AUTO_CAL_DETECTION_COOLDOWN_MS = 120;
  const AUTO_CAL_OUTLIER_WINDOW_MS = 130;
  const AUTO_CAL_MIN_MATCH_COUNT = 4;

  const rateInput = document.getElementById("rateInput");
  const rateValueEl = document.getElementById("rateValue");
  const delayInput = document.getElementById("delayInput");
  const delayValueEl = document.getElementById("delayValue");
  const delayPresetNameInput = document.getElementById("delayPresetNameInput");
  const saveDelayPresetBtn = document.getElementById("saveDelayPresetBtn");
  const delayPresetList = document.getElementById("delayPresetList");

  const autoCalibrateBtn = document.getElementById("autoCalibrateBtn");
  const autoCalibrationStatusEl = document.getElementById("autoCalibrationStatus");
  const micInputSelect = document.getElementById("micInputSelect");
  const refreshMicInputsBtn = document.getElementById("refreshMicInputsBtn");

  const calibrateBtn = document.getElementById("calibrateBtn");
  const calibrationPanel = document.getElementById("calibrationPanel");
  const calibrationCanvas = document.getElementById("calibrationCanvas");
  const calibrationStepEl = document.getElementById("calibrationStep");
  const calibrationOffsetRange = document.getElementById("calibrationOffsetRange");
  const calibrationValueEl = document.getElementById("calibrationValue");
  const calibrationApplyBtn = document.getElementById("calibrationApplyBtn");

  const statusEl = document.getElementById("status");

  let statusTimer;
  let rateWriteTimer;
  let delayWriteTimer;

  const calibrationState = {
    active: false,
    startAtMs: 0,
    frameId: 0,
    lastAudioCrossingIndex: -1,
    previewOffsetMs: DEFAULT_VIDEO_DELAY_MS,
    savedDelayMs: DEFAULT_VIDEO_DELAY_MS,
    audioContext: null,
    referenceLineX: null,
  };

  const autoCalibrationState = {
    active: false,
    rafId: 0,
    audioContext: null,
    micStream: null,
    micSource: null,
    analyser: null,
    frequencyData: null,
    toneBin: 0,
    baselineDb: -120,
    scheduledPulseTimesMs: [],
    detectedPulseTimesMs: [],
    lastDetectionAtMs: -Infinity,
    endAtMs: 0,
  };

  let desiredMicDeviceId = "";
  let delayPresets = [];

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

  const normalizeDelayPresetName = (value) => {
    if (typeof value !== "string") return "";
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.slice(0, MAX_DELAY_PRESET_NAME_CHARS);
  };

  const createDelayPresetId = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  const normalizeDelayPresets = (value) => {
    if (!Array.isArray(value)) return [];

    const results = [];
    const seenIds = new Set();

    for (const item of value) {
      if (!item || typeof item !== "object") continue;

      const name = normalizeDelayPresetName(item.name);
      if (!name) continue;

      const preset = {
        id:
          typeof item.id === "string" && item.id.trim()
            ? item.id
            : createDelayPresetId(),
        name,
        delayMs: normalizeDelay(item.delayMs),
      };

      if (seenIds.has(preset.id)) continue;
      seenIds.add(preset.id);
      results.push(preset);

      if (results.length >= MAX_DELAY_PRESETS) break;
    }

    return results;
  };

  const saveDelayPresets = (sourceText = "") => {
    chrome.storage.local.set({ [STORAGE_KEYS.delayPresets]: delayPresets }, () => {
      if (sourceText) {
        setStatus(sourceText);
      }
    });
  };

  const syncActiveDelayPreset = () => {
    if (!delayPresetList) return;
    const activeDelay = normalizeDelay(delayInput?.value ?? calibrationState.savedDelayMs);

    delayPresetList
      .querySelectorAll(".saved-delay-apply")
      .forEach((button) => {
        if (!(button instanceof HTMLElement)) return;
        const preset = delayPresets.find((item) => item.id === button.dataset.presetId);
        const isActive = Boolean(preset && preset.delayMs === activeDelay);
        button.classList.toggle("is-active", isActive);
      });
  };

  const renderDelayPresets = () => {
    if (!delayPresetList) return;

    delayPresetList.innerHTML = "";

    if (!delayPresets.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "saved-delay-empty";
      emptyState.textContent = "No saved delays yet.";
      delayPresetList.appendChild(emptyState);
      return;
    }

    const activeDelay = normalizeDelay(delayInput?.value ?? calibrationState.savedDelayMs);

    delayPresets.forEach((preset) => {
      const row = document.createElement("div");
      row.className = "saved-delay-item";

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "saved-delay-apply";
      if (preset.delayMs === activeDelay) {
        applyBtn.classList.add("is-active");
      }
      applyBtn.dataset.action = "apply-delay-preset";
      applyBtn.dataset.presetId = preset.id;

      const nameEl = document.createElement("span");
      nameEl.className = "saved-delay-name";
      nameEl.textContent = preset.name;

      const valueEl = document.createElement("span");
      valueEl.className = "saved-delay-ms";
      valueEl.textContent = `${toDisplayDelay(preset.delayMs)} ms`;

      applyBtn.append(nameEl, valueEl);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "saved-delay-remove";
      removeBtn.dataset.action = "remove-delay-preset";
      removeBtn.dataset.presetId = preset.id;
      removeBtn.textContent = "Remove";
      removeBtn.setAttribute("aria-label", `Remove delay preset ${preset.name}`);

      row.append(applyBtn, removeBtn);
      delayPresetList.appendChild(row);
    });

    syncActiveDelayPreset();
  };

  const setRateUi = (value) => {
    const normalized = normalizeRate(value);
    if (rateInput) {
      rateInput.value = toDisplayRate(normalized);
    }
    if (rateValueEl) {
      rateValueEl.textContent = `${toDisplayRate(normalized)}x`;
    }
  };

  const setDelayUi = (value) => {
    const normalized = normalizeDelay(value);
    if (delayInput) {
      delayInput.value = toDisplayDelay(normalized);
    }
    if (delayValueEl) {
      delayValueEl.textContent = `${toDisplayDelay(normalized)} ms`;
    }
    syncActiveDelayPreset();
  };

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, STATUS_MS);
  };

  const setAutoCalibrationStatus = (text) => {
    if (!autoCalibrationStatusEl) return;
    autoCalibrationStatusEl.textContent = text;
  };

  const updateAutoCalibrationUi = () => {
    if (autoCalibrateBtn) {
      autoCalibrateBtn.textContent = autoCalibrationState.active
        ? "Stop Auto Calibration"
        : "Auto Calibrate With Mic";
    }

    if (calibrateBtn) {
      calibrateBtn.disabled = autoCalibrationState.active;
    }

    if (micInputSelect) {
      micInputSelect.disabled = autoCalibrationState.active;
    }
    if (refreshMicInputsBtn) {
      refreshMicInputsBtn.disabled = autoCalibrationState.active;
    }
  };

  const readStoredSettings = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(
        [
          STORAGE_KEYS.rate,
          STORAGE_KEYS.videoDelayMs,
          STORAGE_KEYS.micDeviceId,
          STORAGE_KEYS.delayPresets,
        ],
        (res) => {
          resolve({
            rate: normalizeRate(res?.[STORAGE_KEYS.rate]),
            delayMs: normalizeDelay(res?.[STORAGE_KEYS.videoDelayMs]),
            micDeviceId:
              typeof res?.[STORAGE_KEYS.micDeviceId] === "string"
                ? res[STORAGE_KEYS.micDeviceId]
                : "",
            delayPresets: normalizeDelayPresets(res?.[STORAGE_KEYS.delayPresets]),
          });
        },
      );
    });

  const writeRate = (value, source, silentStatus = false) => {
    const normalized = normalizeRate(value);
    chrome.storage.local.set({ [STORAGE_KEYS.rate]: normalized }, () => {
      setRateUi(normalized);
      if (!silentStatus && source) {
        setStatus(`${source} ${toDisplayRate(normalized)}x`);
      }
    });
  };

  const writeDelay = (value, source, silentStatus = false) => {
    const normalized = normalizeDelay(value);
    chrome.storage.local.set({ [STORAGE_KEYS.videoDelayMs]: normalized }, () => {
      setDelayUi(normalized);

      calibrationState.savedDelayMs = normalized;
      if (!calibrationState.active) {
        setCalibrationPreviewDelay(normalized);
      }

      if (!silentStatus && source) {
        setStatus(`${source} ${toDisplayDelay(normalized)} ms`);
      }
    });
  };

  const writeMicDeviceId = (value) => {
    desiredMicDeviceId = typeof value === "string" ? value : "";
    chrome.storage.local.set({ [STORAGE_KEYS.micDeviceId]: desiredMicDeviceId });
  };

  const buildMicOptionLabel = (device, index) => {
    const label = (device?.label || "").trim();
    if (label) return label;
    return `Microphone ${index + 1}`;
  };

  const ensureMicDefaultOption = () => {
    if (!micInputSelect) return;

    micInputSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Default microphone";
    micInputSelect.appendChild(option);
    micInputSelect.value = "";
  };

  const refreshMicInputs = async (preferredDeviceId = desiredMicDeviceId) => {
    if (!micInputSelect) return;
    if (!navigator.mediaDevices?.enumerateDevices) {
      ensureMicDefaultOption();
      return;
    }

    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      ensureMicDefaultOption();
      return;
    }

    const mics = devices.filter((device) => device.kind === "audioinput");
    micInputSelect.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Default microphone";
    micInputSelect.appendChild(defaultOption);

    mics.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = buildMicOptionLabel(device, index);
      micInputSelect.appendChild(option);
    });

    const hasPreferred =
      preferredDeviceId &&
      mics.some((device) => device.deviceId === preferredDeviceId);
    micInputSelect.value = hasPreferred ? preferredDeviceId : "";

    if (hasPreferred) {
      desiredMicDeviceId = preferredDeviceId;
    } else if (preferredDeviceId) {
      writeMicDeviceId("");
      setAutoCalibrationStatus("Selected mic unavailable. Using default microphone.");
    }
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

  const scheduleCalibrationTone = (context, startAtSeconds) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(AUTO_CAL_TONE_HZ, startAtSeconds);

    gain.gain.setValueAtTime(0.0001, startAtSeconds);
    gain.gain.exponentialRampToValueAtTime(0.2, startAtSeconds + 0.004);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      startAtSeconds + AUTO_CAL_TONE_DURATION_MS / 1000,
    );

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start(startAtSeconds);
    oscillator.stop(startAtSeconds + AUTO_CAL_TONE_DURATION_MS / 1000 + 0.005);
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
      const now = context.currentTime + CAL_CLICK_SCHEDULE_LEAD_MS / 1000;
      scheduleCalibrationTone(context, now);
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

  const getSweepX = (nowMs, width) => {
    const adjustedTime = nowMs - calibrationState.previewOffsetMs;
    const adjustedElapsedMs = adjustedTime - calibrationState.startAtMs;
    const progress = getSweepProgress(adjustedElapsedMs);
    return CAL_CANVAS_PAD + progress * (width - CAL_CANVAS_PAD * 2);
  };

  const drawCalibration = (nowMs) => {
    if (!calibrationCanvas) return;
    const ctx = calibrationCanvas.getContext("2d");
    if (!ctx) return;

    const width = calibrationCanvas.width;
    const height = calibrationCanvas.height;
    const centerX = width / 2;
    const lineY = Math.round(height * 0.6);

    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "#0f1a23";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(190, 209, 222, 0.2)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CAL_CANVAS_PAD, lineY);
    ctx.lineTo(width - CAL_CANVAS_PAD, lineY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 147, 104, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, lineY - 23);
    ctx.lineTo(centerX, lineY + 23);
    ctx.stroke();

    const movingX = getSweepX(nowMs, width);

    if (calibrationState.referenceLineX !== null) {
      ctx.strokeStyle = "rgba(88, 195, 216, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(calibrationState.referenceLineX, lineY - 18);
      ctx.lineTo(calibrationState.referenceLineX, lineY + 18);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(235, 243, 249, 0.95)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(movingX, lineY - 20);
    ctx.lineTo(movingX, lineY + 20);
    ctx.stroke();

    ctx.fillStyle = "rgba(187, 204, 216, 0.8)";
    ctx.font = "11px Sora, Avenir Next, Trebuchet MS, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
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
      if (!calibrationState.active) {
        calibrationStepEl.textContent =
          "Start calibration. Click the sweep to drop a marker line where the moving line is.";
      } else {
        calibrationStepEl.textContent =
          "Click the canvas to place or replace a marker line at the moving line position.";
      }
    }

    if (calibrationValueEl) {
      calibrationValueEl.textContent = `${toDisplayDelay(calibrationState.previewOffsetMs)} ms`;
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

    updateAutoCalibrationUi();
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
    calibrationState.referenceLineX = null;

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
    if (autoCalibrationState.active) {
      setStatus("Stop auto calibration first");
      return;
    }

    if (calibrationState.active) {
      stopCalibration();
      return;
    }

    const seed = normalizeDelay(delayInput?.value ?? calibrationState.savedDelayMs);
    setCalibrationPreviewDelay(seed);
    startCalibration();
  };

  const setCalibrationReferenceLine = () => {
    if (!calibrationCanvas || !calibrationState.active) return;
    calibrationState.referenceLineX = getSweepX(
      performance.now(),
      calibrationCanvas.width,
    );
    setStatus("Marker line updated");
  };

  const applyCalibrationDelay = () => {
    writeDelay(calibrationState.previewOffsetMs, "Calibrated to");
  };

  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const cleanupAutoCalibrationResources = () => {
    if (autoCalibrationState.rafId) {
      cancelAnimationFrame(autoCalibrationState.rafId);
    }
    autoCalibrationState.rafId = 0;

    autoCalibrationState.micSource?.disconnect();
    autoCalibrationState.micSource = null;
    autoCalibrationState.analyser?.disconnect();
    autoCalibrationState.analyser = null;
    autoCalibrationState.frequencyData = null;

    if (autoCalibrationState.micStream) {
      autoCalibrationState.micStream.getTracks().forEach((track) => {
        track.stop();
      });
    }
    autoCalibrationState.micStream = null;
  };

  const stopAutoCalibration = (message, silent = false) => {
    const wasActive = autoCalibrationState.active;

    autoCalibrationState.active = false;
    cleanupAutoCalibrationResources();

    autoCalibrationState.audioContext = null;
    autoCalibrationState.scheduledPulseTimesMs = [];
    autoCalibrationState.detectedPulseTimesMs = [];
    autoCalibrationState.lastDetectionAtMs = -Infinity;
    autoCalibrationState.endAtMs = 0;

    updateAutoCalibrationUi();

    if (!silent && message) {
      setAutoCalibrationStatus(message);
    }

    if (wasActive && !silent) {
      setStatus("Auto calibration stopped");
    }
  };

  const getToneDb = () => {
    if (!autoCalibrationState.analyser || !autoCalibrationState.frequencyData) {
      return -Infinity;
    }

    autoCalibrationState.analyser.getFloatFrequencyData(
      autoCalibrationState.frequencyData,
    );

    let sum = 0;
    let count = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const index = autoCalibrationState.toneBin + offset;
      if (
        index < 0 ||
        index >= autoCalibrationState.frequencyData.length ||
        !Number.isFinite(autoCalibrationState.frequencyData[index])
      ) {
        continue;
      }
      sum += autoCalibrationState.frequencyData[index];
      count += 1;
    }

    if (!count) return -Infinity;
    return sum / count;
  };

  const computeAutoDelay = (scheduledPulseTimesMs, detectedPulseTimesMs) => {
    if (!scheduledPulseTimesMs.length || !detectedPulseTimesMs.length) {
      return null;
    }

    const lagSamples = [];
    let detectionIndex = 0;

    for (const scheduledTimeMs of scheduledPulseTimesMs) {
      while (
        detectionIndex < detectedPulseTimesMs.length &&
        detectedPulseTimesMs[detectionIndex] < scheduledTimeMs + AUTO_CAL_MIN_LAG_MS
      ) {
        detectionIndex += 1;
      }

      if (detectionIndex >= detectedPulseTimesMs.length) {
        break;
      }

      const lagMs = detectedPulseTimesMs[detectionIndex] - scheduledTimeMs;
      if (lagMs > AUTO_CAL_MAX_LAG_MS) {
        continue;
      }

      lagSamples.push(lagMs);
      detectionIndex += 1;
    }

    if (lagSamples.length < AUTO_CAL_MIN_MATCH_COUNT) {
      return null;
    }

    const lagMedian = median(lagSamples);
    const filteredSamples = lagSamples.filter(
      (lagMs) => Math.abs(lagMs - lagMedian) <= AUTO_CAL_OUTLIER_WINDOW_MS,
    );

    const finalSamples =
      filteredSamples.length >= AUTO_CAL_MIN_MATCH_COUNT
        ? filteredSamples
        : lagSamples;

    return {
      delayMs: normalizeDelay(median(finalSamples)),
      rawMatches: lagSamples.length,
      usedMatches: finalSamples.length,
    };
  };

  const finishAutoCalibration = () => {
    const result = computeAutoDelay(
      autoCalibrationState.scheduledPulseTimesMs,
      autoCalibrationState.detectedPulseTimesMs,
    );

    const pulseCount = autoCalibrationState.scheduledPulseTimesMs.length;
    stopAutoCalibration("", true);

    if (!result) {
      setAutoCalibrationStatus(
        "No stable mic match found. Raise speaker volume, move mic closer, and try again.",
      );
      setStatus("Auto calibration failed");
      return;
    }

    writeDelay(result.delayMs, "Auto-calibrated to");
    setAutoCalibrationStatus(
      `Auto result: ${toDisplayDelay(result.delayMs)} ms (${result.usedMatches}/${pulseCount} pulses used).`,
    );
  };

  const tickAutoCalibration = () => {
    if (!autoCalibrationState.active || !autoCalibrationState.audioContext) {
      return;
    }

    const nowMs = autoCalibrationState.audioContext.currentTime * 1000;
    const firstPulseMs = autoCalibrationState.scheduledPulseTimesMs[0] ?? nowMs;

    const toneDb = getToneDb();
    if (Number.isFinite(toneDb)) {
      const blend = nowMs < firstPulseMs - 40 ? 0.18 : 0.03;
      autoCalibrationState.baselineDb +=
        (toneDb - autoCalibrationState.baselineDb) * blend;

      const threshold = Math.max(
        AUTO_CAL_MIN_PEAK_DB,
        autoCalibrationState.baselineDb + AUTO_CAL_MIN_RISE_DB,
      );

      if (
        toneDb >= threshold &&
        nowMs - autoCalibrationState.lastDetectionAtMs >=
          AUTO_CAL_DETECTION_COOLDOWN_MS
      ) {
        autoCalibrationState.lastDetectionAtMs = nowMs;
        autoCalibrationState.detectedPulseTimesMs.push(nowMs);
      }
    }

    if (nowMs >= autoCalibrationState.endAtMs) {
      finishAutoCalibration();
      return;
    }

    autoCalibrationState.rafId = requestAnimationFrame(tickAutoCalibration);
  };

  const buildMicAudioConstraints = (deviceId) => {
    const constraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };

    if (deviceId) {
      constraints.deviceId = { exact: deviceId };
    }

    return constraints;
  };

  const getSelectedMicDeviceId = () =>
    typeof micInputSelect?.value === "string" ? micInputSelect.value : desiredMicDeviceId;

  const startAutoCalibration = async () => {
    if (autoCalibrationState.active) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setAutoCalibrationStatus("Microphone access is not available in this browser.");
      setStatus("Auto calibration unavailable");
      return;
    }

    if (calibrationState.active) {
      stopCalibration();
    }

    const context = ensureCalibrationAudioContext();
    if (!context) {
      setAutoCalibrationStatus("AudioContext is unavailable here.");
      setStatus("Auto calibration unavailable");
      return;
    }

    if (context.state === "suspended") {
      await context.resume().catch(() => {
        // browser may still block until another gesture
      });
    }

    setAutoCalibrationStatus("Requesting microphone access...");

    let micStream = null;
    const selectedMicDeviceId = getSelectedMicDeviceId();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicAudioConstraints(selectedMicDeviceId),
      });
    } catch (error) {
      const canFallbackToDefault = Boolean(selectedMicDeviceId);
      if (!canFallbackToDefault) {
        const detail =
          error?.name === "NotAllowedError" ? "permission denied" : "access failed";
        setAutoCalibrationStatus(`Microphone ${detail}. Allow mic access and retry.`);
        setStatus("Auto calibration failed");
        return;
      }

      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: buildMicAudioConstraints(""),
        });
        writeMicDeviceId("");
        await refreshMicInputs("");
        setAutoCalibrationStatus(
          "Selected microphone is unavailable. Falling back to default microphone.",
        );
      } catch (fallbackError) {
        const detail =
          fallbackError?.name === "NotAllowedError"
            ? "permission denied"
            : "access failed";
        setAutoCalibrationStatus(`Microphone ${detail}. Allow mic access and retry.`);
        setStatus("Auto calibration failed");
        return;
      }
    }

    const selectedAfterPrompt = getSelectedMicDeviceId();
    await refreshMicInputs(selectedAfterPrompt);

    let source = null;
    let analyser = null;

    try {
      source = context.createMediaStreamSource(micStream);
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
    } catch (_) {
      micStream.getTracks().forEach((track) => {
        track.stop();
      });
      setAutoCalibrationStatus("Unable to process mic input on this device.");
      setStatus("Auto calibration failed");
      return;
    }

    autoCalibrationState.active = true;
    autoCalibrationState.audioContext = context;
    autoCalibrationState.micStream = micStream;
    autoCalibrationState.micSource = source;
    autoCalibrationState.analyser = analyser;
    autoCalibrationState.frequencyData = new Float32Array(analyser.frequencyBinCount);
    autoCalibrationState.baselineDb = -120;
    autoCalibrationState.lastDetectionAtMs = -Infinity;

    autoCalibrationState.toneBin = Math.min(
      analyser.frequencyBinCount - 1,
      Math.max(
        0,
        Math.round((AUTO_CAL_TONE_HZ / context.sampleRate) * analyser.fftSize),
      ),
    );

    const startAtSeconds = context.currentTime + AUTO_CAL_START_LEAD_MS / 1000;
    autoCalibrationState.scheduledPulseTimesMs = [];
    autoCalibrationState.detectedPulseTimesMs = [];

    for (let index = 0; index < AUTO_CAL_PULSE_COUNT; index += 1) {
      const startTime = startAtSeconds + (index * AUTO_CAL_PULSE_INTERVAL_MS) / 1000;
      autoCalibrationState.scheduledPulseTimesMs.push(startTime * 1000);
      scheduleCalibrationTone(context, startTime);
    }

    autoCalibrationState.endAtMs =
      startAtSeconds * 1000 +
      (AUTO_CAL_PULSE_COUNT - 1) * AUTO_CAL_PULSE_INTERVAL_MS +
      AUTO_CAL_CAPTURE_TAIL_MS;

    const activeMicLabel =
      micInputSelect?.selectedOptions?.[0]?.textContent || "selected microphone";
    setAutoCalibrationStatus(
      `Listening for speaker tones now using ${activeMicLabel}. Keep the popup open and mic near the speaker.`,
    );

    updateAutoCalibrationUi();

    autoCalibrationState.rafId = requestAnimationFrame(tickAutoCalibration);
  };

  const toggleAutoCalibration = () => {
    if (autoCalibrationState.active) {
      stopAutoCalibration("Auto calibration canceled");
      return;
    }
    startAutoCalibration();
  };

  const scheduleRateWrite = (value) => {
    clearTimeout(rateWriteTimer);
    rateWriteTimer = setTimeout(() => {
      writeRate(value, "Speed set to", true);
    }, SLIDER_WRITE_DEBOUNCE_MS);
  };

  const scheduleDelayWrite = (value) => {
    clearTimeout(delayWriteTimer);
    delayWriteTimer = setTimeout(() => {
      writeDelay(value, "Delay set to", true);
    }, SLIDER_WRITE_DEBOUNCE_MS);
  };

  const commitRateInput = () => {
    if (!rateInput) return;
    writeRate(rateInput.value, "Speed set to");
  };

  const commitDelayInput = () => {
    if (!delayInput) return;
    writeDelay(delayInput.value, "Delay set to");
  };

  const applyDelayPresetById = (presetId) => {
    const preset = delayPresets.find((item) => item.id === presetId);
    if (!preset) return;
    writeDelay(preset.delayMs, `Applied "${preset.name}"`);
  };

  const removeDelayPresetById = (presetId) => {
    const preset = delayPresets.find((item) => item.id === presetId);
    if (!preset) return;

    delayPresets = delayPresets.filter((item) => item.id !== presetId);
    renderDelayPresets();
    saveDelayPresets(`Removed "${preset.name}"`);
  };

  const saveCurrentDelayPreset = () => {
    const currentDelayMs = normalizeDelay(delayInput?.value ?? calibrationState.savedDelayMs);
    const typedName = normalizeDelayPresetName(delayPresetNameInput?.value ?? "");
    const presetName = typedName || `Delay ${toDisplayDelay(currentDelayMs)} ms`;

    const existingIndex = delayPresets.findIndex(
      (preset) => preset.name.toLowerCase() === presetName.toLowerCase(),
    );

    if (existingIndex >= 0) {
      delayPresets[existingIndex] = {
        ...delayPresets[existingIndex],
        delayMs: currentDelayMs,
        name: presetName,
      };
      if (delayPresetNameInput) {
        delayPresetNameInput.value = "";
      }
      renderDelayPresets();
      saveDelayPresets(`Updated "${presetName}"`);
      return;
    }

    delayPresets = [
      {
        id: createDelayPresetId(),
        name: presetName,
        delayMs: currentDelayMs,
      },
      ...delayPresets,
    ].slice(0, MAX_DELAY_PRESETS);

    if (delayPresetNameInput) {
      delayPresetNameInput.value = "";
    }

    renderDelayPresets();
    saveDelayPresets(`Saved "${presetName}"`);
  };

  const init = async () => {
    const current = await readStoredSettings();
    calibrationState.savedDelayMs = current.delayMs;
    desiredMicDeviceId = current.micDeviceId;
    delayPresets = current.delayPresets;

    setRateUi(current.rate);
    setDelayUi(current.delayMs);
    renderDelayPresets();

    setCalibrationPreviewDelay(current.delayMs);

    rateInput?.addEventListener("input", () => {
      setRateUi(rateInput.value);
      scheduleRateWrite(rateInput.value);
    });
    rateInput?.addEventListener("change", () => {
      clearTimeout(rateWriteTimer);
      commitRateInput();
    });

    delayInput?.addEventListener("input", () => {
      setDelayUi(delayInput.value);
      scheduleDelayWrite(delayInput.value);
    });
    delayInput?.addEventListener("change", () => {
      clearTimeout(delayWriteTimer);
      commitDelayInput();
    });

    saveDelayPresetBtn?.addEventListener("click", saveCurrentDelayPreset);

    delayPresetNameInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      saveCurrentDelayPreset();
    });

    delayPresetList?.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const actionButton = event.target.closest("button[data-action]");
      if (!actionButton) return;

      const presetId = actionButton.dataset.presetId;
      if (!presetId) return;

      const action = actionButton.dataset.action;
      if (action === "apply-delay-preset") {
        applyDelayPresetById(presetId);
      } else if (action === "remove-delay-preset") {
        removeDelayPresetById(presetId);
      }
    });

    micInputSelect?.addEventListener("change", () => {
      writeMicDeviceId(micInputSelect.value);
    });

    refreshMicInputsBtn?.addEventListener("click", () => {
      refreshMicInputs(micInputSelect?.value ?? desiredMicDeviceId);
    });

    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        refreshMicInputs(micInputSelect?.value ?? desiredMicDeviceId);
      });
    }

    autoCalibrateBtn?.addEventListener("click", toggleAutoCalibration);

    calibrateBtn?.addEventListener("click", toggleCalibration);

    calibrationOffsetRange?.addEventListener("input", () => {
      setCalibrationPreviewDelay(calibrationOffsetRange.value);
    });

    calibrationCanvas?.addEventListener("click", setCalibrationReferenceLine);

    calibrationApplyBtn?.addEventListener("click", applyCalibrationDelay);

    setAutoCalibrationStatus(
      "Auto calibration listens for test tones through your mic and estimates delay.",
    );
    await refreshMicInputs(desiredMicDeviceId);
    updateCalibrationUi();
  };

  window.addEventListener("beforeunload", () => {
    clearTimeout(rateWriteTimer);
    clearTimeout(delayWriteTimer);
    stopAutoCalibration("", true);
  });

  init();
})();
