(() => {
  const STORAGE_KEYS = Object.freeze({
    rate: "yt_control_playback_rate",
    videoDelayMs: "yt_control_video_delay_ms",
    micDeviceId: "yt_control_mic_device_id",
  });

  const RATE_RANGE = Object.freeze({
    defaultValue: 1,
    min: 0.1,
    max: 8,
  });

  const DELAY_RANGE = Object.freeze({
    defaultValue: 0,
    min: 0,
    max: 2500,
  });

  const clampNumber = (
    value,
    { defaultValue, min, max, rejectZeroOrLess = false },
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (rejectZeroOrLess && parsed <= 0)) {
      return defaultValue;
    }

    return Math.min(max, Math.max(min, parsed));
  };

  const normalizeRate = (value) =>
    clampNumber(value, {
      ...RATE_RANGE,
      rejectZeroOrLess: true,
    });

  const normalizeDelay = (value) => clampNumber(value, DELAY_RANGE);

  const toDisplayRate = (value) =>
    String(Math.round(normalizeRate(value) * 100) / 100);

  const toDisplayDelay = (value) => String(normalizeDelay(value));

  const readStorage = (keys, mapResult) =>
    new Promise((resolve) => {
      try {
        chrome.storage?.local.get(keys, (result) => {
          resolve(mapResult(result || {}));
        });
      } catch (_) {
        resolve(mapResult({}));
      }
    });

  const writeStorage = (values, onComplete) => {
    try {
      chrome.storage?.local.set(values, () => {
        onComplete?.();
      });
    } catch (_) {
      onComplete?.();
    }
  };

  globalThis.YtControlShared = Object.freeze({
    DELAY_RANGE,
    RATE_RANGE,
    STORAGE_KEYS,
    normalizeDelay,
    normalizeRate,
    readStorage,
    toDisplayDelay,
    toDisplayRate,
    writeStorage,
  });
})();
