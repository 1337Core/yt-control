import {
  DELAY_RANGE,
  RATE_RANGE,
  STORAGE_KEYS,
  normalizeDelay,
  normalizeRate,
  readStorage,
  toDisplayDelay,
  toDisplayRate,
  writeStorage
} from "~lib/settings"

export const createPopupController = (root) => {
  if (!root) {
    return () => {}
  }

  const DEFAULT_RATE = RATE_RANGE.defaultValue;
  const MIN_RATE = RATE_RANGE.min;
  const MAX_RATE = RATE_RANGE.max;

  const DEFAULT_VIDEO_DELAY_MS = DELAY_RANGE.defaultValue;
  const MIN_VIDEO_DELAY_MS = DELAY_RANGE.min;
  const MAX_VIDEO_DELAY_MS = DELAY_RANGE.max;

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

  const rateInput = root.querySelector("#rateInput");
  const rateValueEl = root.querySelector("#rateValue");
  const delayInput = root.querySelector("#delayInput");
  const delayValueEl = root.querySelector("#delayValue");

  const autoCalibrateBtn = root.querySelector("#autoCalibrateBtn");
  const autoCalibrationStatusEl = root.querySelector("#autoCalibrationStatus");
  const micInputSelect = root.querySelector("#micInputSelect");
  const refreshMicInputsBtn = root.querySelector("#refreshMicInputsBtn");

  const calibrateBtn = root.querySelector("#calibrateBtn");
  const calibrationPanel = root.querySelector("#calibrationPanel");
  const calibrationCanvas = root.querySelector("#calibrationCanvas");
  const calibrationStepEl = root.querySelector("#calibrationStep");
  const calibrationOffsetRange = root.querySelector("#calibrationOffsetRange");
  const calibrationValueEl = root.querySelector("#calibrationValue");
  const calibrationApplyBtn = root.querySelector("#calibrationApplyBtn");

  const statusEl = root.querySelector("#status");

  let statusTimer;
  let currentDelayMs = DEFAULT_VIDEO_DELAY_MS;

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
    currentDelayMs = normalized;
    if (delayInput) {
      delayInput.value = toDisplayDelay(normalized);
    }
    if (delayValueEl) {
      delayValueEl.textContent = `${toDisplayDelay(normalized)} ms`;
    }
  };

  const startInlineValueEditor = ({
    outputEl,
    currentValue,
    min,
    max,
    step,
    normalizeValue,
    formatValue,
    invalidMessage,
    onCommit,
  }) => {
    if (!outputEl || outputEl.dataset.editing === "true") return;

    const input = document.createElement("input");
    input.type = "number";
    input.className = "value-editor-input";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = formatValue(currentValue);

    outputEl.dataset.editing = "true";
    outputEl.hidden = true;
    outputEl.insertAdjacentElement("afterend", input);

    let finalized = false;
    const finish = (commit) => {
      if (finalized) return;
      finalized = true;

      if (commit) {
        const rawValue = input.value.trim();
        const parsed = Number(rawValue);
        if (rawValue && Number.isFinite(parsed)) {
          onCommit(normalizeValue(parsed));
        } else if (rawValue) {
          setStatus(invalidMessage);
        }
      }

      input.remove();
      outputEl.hidden = false;
      delete outputEl.dataset.editing;
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });

    input.addEventListener("blur", () => {
      finish(true);
    });

    input.focus();
    input.select();
  };

  const setupInlineValueEditor = ({
    outputEl,
    title,
    currentValue,
    min,
    max,
    step,
    normalizeValue,
    formatValue,
    invalidMessage,
    onCommit,
  }) => {
    if (!outputEl) return;

    const beginEdit = () => {
      startInlineValueEditor({
        outputEl,
        currentValue: currentValue(),
        min,
        max,
        step,
        normalizeValue,
        formatValue,
        invalidMessage,
        onCommit,
      });
    };

    outputEl.classList.add("editable-value");
    outputEl.tabIndex = 0;
    outputEl.title = title;
    outputEl.setAttribute("role", "button");

    outputEl.addEventListener("click", (event) => {
      event.preventDefault();
      beginEdit();
    });

    outputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      beginEdit();
    });
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
        ? "Stop Auto"
        : "Auto";
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
    readStorage(
      [STORAGE_KEYS.rate, STORAGE_KEYS.videoDelayMs, STORAGE_KEYS.micDeviceId],
      (stored) => ({
        rate: normalizeRate(stored[STORAGE_KEYS.rate]),
        delayMs: normalizeDelay(stored[STORAGE_KEYS.videoDelayMs]),
        micDeviceId:
          typeof stored[STORAGE_KEYS.micDeviceId] === "string"
            ? stored[STORAGE_KEYS.micDeviceId]
            : "",
      }),
    );

  const createStorageWriter =
    ({ storageKey, normalizeValue, applyUi, formatStatus, onAfterWrite }) =>
    (value, source, silentStatus = false) => {
      const normalized = normalizeValue(value);
      writeStorage({ [storageKey]: normalized }, () => {
        applyUi(normalized);
        onAfterWrite?.(normalized);

        if (!silentStatus && source) {
          setStatus(`${source} ${formatStatus(normalized)}`);
        }
      });
    };

  const writeRate = createStorageWriter({
    storageKey: STORAGE_KEYS.rate,
    normalizeValue: normalizeRate,
    applyUi: setRateUi,
    formatStatus: (normalized) => `${toDisplayRate(normalized)}x`,
  });

  const writeDelay = createStorageWriter({
    storageKey: STORAGE_KEYS.videoDelayMs,
    normalizeValue: normalizeDelay,
    applyUi: setDelayUi,
    formatStatus: (normalized) => `${toDisplayDelay(normalized)} ms`,
    onAfterWrite: (normalized) => {
      calibrationState.savedDelayMs = normalized;
      if (!calibrationState.active) {
        setCalibrationPreviewDelay(normalized);
      }
    },
  });

  const writeMicDeviceId = (value) => {
    desiredMicDeviceId = typeof value === "string" ? value : "";
    writeStorage({ [STORAGE_KEYS.micDeviceId]: desiredMicDeviceId });
  };

  const buildMicOptionLabel = (device, index) => {
    const label = (device?.label || "").trim();
    if (label) return label;
    return `Mic ${index + 1}`;
  };

  const ensureMicDefaultOption = () => {
    if (!micInputSelect) return;

    micInputSelect.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Default mic";
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
    defaultOption.textContent = "Default mic";
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
      setAutoCalibrationStatus("Selected mic unavailable. Using default.");
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
          "Start manual calibration. Click sweep to place marker.";
      } else {
        calibrationStepEl.textContent =
          "Click canvas to move marker.";
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
      if (calibrateBtn) calibrateBtn.textContent = "Stop Manual";
    } else {
      calibrationPanel.hidden = true;
      if (calibrateBtn) calibrateBtn.textContent = "Manual";
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
      setStatus("Stop auto first");
      return;
    }

    if (calibrationState.active) {
      stopCalibration();
      return;
    }

    const seed = normalizeDelay(currentDelayMs);
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
      setStatus("Auto stopped");
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
      delayMs: Math.round(normalizeDelay(median(finalSamples))),
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
        "No stable match. Raise volume and move mic closer.",
      );
      setStatus("Auto failed");
      return;
    }

    writeDelay(result.delayMs, "Auto-calibrated to");
    setAutoCalibrationStatus(
      `Auto: ${toDisplayDelay(result.delayMs)} ms (${result.usedMatches}/${pulseCount}).`,
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
      setAutoCalibrationStatus("Mic access unavailable.");
      setStatus("Auto unavailable");
      return;
    }

    if (calibrationState.active) {
      stopCalibration();
    }

    const context = ensureCalibrationAudioContext();
    if (!context) {
      setAutoCalibrationStatus("Audio unavailable.");
      setStatus("Auto unavailable");
      return;
    }

    if (context.state === "suspended") {
      await context.resume().catch(() => {
        // browser may still block until another gesture
      });
    }

    setAutoCalibrationStatus("Requesting mic access...");

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
        setAutoCalibrationStatus(`Mic ${detail}. Allow access and retry.`);
        setStatus("Auto failed");
        return;
      }

      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: buildMicAudioConstraints(""),
        });
        writeMicDeviceId("");
        await refreshMicInputs("");
        setAutoCalibrationStatus("Selected mic unavailable. Using default.");
      } catch (fallbackError) {
        const detail =
          fallbackError?.name === "NotAllowedError"
            ? "permission denied"
            : "access failed";
        setAutoCalibrationStatus(`Mic ${detail}. Allow access and retry.`);
        setStatus("Auto failed");
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
      setAutoCalibrationStatus("Can't process mic input.");
      setStatus("Auto failed");
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
      micInputSelect?.selectedOptions?.[0]?.textContent || "selected mic";
    setAutoCalibrationStatus(
      `Listening on ${activeMicLabel}. Keep mic near speaker.`,
    );

    updateAutoCalibrationUi();

    autoCalibrationState.rafId = requestAnimationFrame(tickAutoCalibration);
  };

  const toggleAutoCalibration = () => {
    if (autoCalibrationState.active) {
      stopAutoCalibration("Auto canceled");
      return;
    }
    startAutoCalibration();
  };

  const createDebouncedWriter = (writeFn) => {
    let timerId = null;

    const cancel = () => {
      if (timerId == null) return;
      clearTimeout(timerId);
      timerId = null;
    };

    return {
      schedule(value) {
        cancel();
        timerId = setTimeout(() => {
          timerId = null;
          writeFn(value, true);
        }, SLIDER_WRITE_DEBOUNCE_MS);
      },
      commit(value) {
        cancel();
        writeFn(value, false);
      },
      flush(value) {
        if (timerId == null) return;
        cancel();
        writeFn(value, true);
      },
      cancel,
    };
  };

  const rateWriter = createDebouncedWriter((value, silentStatus) => {
    writeRate(value, "Speed set to", silentStatus);
  });

  const delayWriter = createDebouncedWriter((value, silentStatus) => {
    writeDelay(value, "Delay set to", silentStatus);
  });

  const getInputStep = (input, fallback) => {
    const parsed = Number(input?.step);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const bindSliderControl = ({ input, onInput, onCommit }) => {
    if (!input) return;

    input.addEventListener("input", () => {
      onInput(input.value);
    });

    input.addEventListener("change", () => {
      onCommit(input.value);
    });
  };

  const queueRateUpdate = (value) => {
    setRateUi(value);
    rateWriter.schedule(value);
  };

  const resetRateInput = () => {
    rateWriter.cancel();
    writeRate(DEFAULT_RATE, "Speed reset to");
  };

  const nudgeRateInput = (direction) => {
    if (!rateInput || !Number.isFinite(direction) || direction === 0) return;
    const step = getInputStep(rateInput, 0.05);
    const next = normalizeRate(Number(rateInput.value) + direction * step);
    queueRateUpdate(next);
  };

  const init = async () => {
    const current = await readStoredSettings();
    calibrationState.savedDelayMs = current.delayMs;
    desiredMicDeviceId = current.micDeviceId;

    setRateUi(current.rate);
    setDelayUi(current.delayMs);

    setCalibrationPreviewDelay(current.delayMs);

    bindSliderControl({
      input: rateInput,
      onInput: queueRateUpdate,
      onCommit: (value) => {
        rateWriter.commit(value);
      },
    });

    rateInput?.addEventListener("dblclick", (event) => {
      event.preventDefault();
      resetRateInput();
    });

    rateInput?.addEventListener("keydown", (event) => {
      const isPlainKey = !event.altKey && !event.ctrlKey && !event.metaKey;
      const key = event.key.toLowerCase();

      if (event.key === "Home" || (isPlainKey && key === "r")) {
        event.preventDefault();
        resetRateInput();
        return;
      }

      if (!isPlainKey) return;

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        nudgeRateInput(1);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        nudgeRateInput(-1);
      }
    });
    rateInput?.addEventListener(
      "wheel",
      (event) => {
        if (Math.abs(event.deltaY) < 0.001) return;
        event.preventDefault();
        nudgeRateInput(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );

    bindSliderControl({
      input: delayInput,
      onInput: (value) => {
        setDelayUi(value);
        delayWriter.schedule(value);
      },
      onCommit: (value) => {
        delayWriter.commit(value);
      },
    });

    setupInlineValueEditor({
      outputEl: rateValueEl,
      title: "Click to edit speed",
      currentValue: () => Number(rateInput?.value ?? DEFAULT_RATE),
      min: MIN_RATE,
      max: MAX_RATE,
      step: getInputStep(rateInput, 0.05),
      normalizeValue: normalizeRate,
      formatValue: toDisplayRate,
      invalidMessage: "Enter a valid speed",
      onCommit: (value) => {
        rateWriter.commit(value);
      },
    });

    setupInlineValueEditor({
      outputEl: delayValueEl,
      title: "Click to edit delay",
      currentValue: () => currentDelayMs,
      min: MIN_VIDEO_DELAY_MS,
      max: MAX_VIDEO_DELAY_MS,
      step: 1,
      normalizeValue: normalizeDelay,
      formatValue: toDisplayDelay,
      invalidMessage: "Enter a valid delay",
      onCommit: (value) => {
        delayWriter.commit(value);
      },
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
      "Auto uses your mic to estimate delay.",
    );
    await refreshMicInputs(desiredMicDeviceId);
    updateCalibrationUi();
  };

  const flushBeforeUnload = () => {
    if (rateInput) rateWriter.flush(rateInput.value);
    if (delayInput) delayWriter.flush(delayInput.value);
    stopAutoCalibration("", true);
  };

  window.addEventListener("beforeunload", flushBeforeUnload);
  init();

  return () => {
    flushBeforeUnload();
    stopCalibration();
    window.removeEventListener("beforeunload", flushBeforeUnload);
  };
};
