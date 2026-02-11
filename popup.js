(() => {
  const STORAGE_KEY = "yt_playback_rate";
  const DEFAULT_RATE = 1;
  const MIN_RATE = 0.1;
  const MAX_RATE = 16;
  const STATUS_MS = 1800;

  const rateInput = document.getElementById("rateInput");
  const applyBtn = document.getElementById("applyBtn");
  const resetBtn = document.getElementById("resetBtn");
  const statusEl = document.getElementById("status");

  let statusTimer;

  const normalizeRate = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RATE;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, parsed));
  };

  const toDisplayRate = (value) => {
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  };

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, STATUS_MS);
  };

  const readStoredRate = () =>
    new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        resolve(normalizeRate(res?.[STORAGE_KEY]));
      });
    });

  const writeRate = (value, source) => {
    const normalized = normalizeRate(value);
    chrome.storage.local.set({ [STORAGE_KEY]: normalized }, () => {
      rateInput.value = toDisplayRate(normalized);
      setStatus(`${source} ${toDisplayRate(normalized)}x`);
    });
  };

  const applyInput = () => writeRate(rateInput.value, "Set to");

  const init = async () => {
    const current = await readStoredRate();
    rateInput.value = toDisplayRate(current);

    applyBtn.addEventListener("click", applyInput);
    rateInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyInput();
    });

    resetBtn.addEventListener("click", () => writeRate(DEFAULT_RATE, "Reset to"));

    document.querySelectorAll("button[data-rate]").forEach((button) => {
      button.addEventListener("click", () => {
        writeRate(button.dataset.rate, "Set to");
      });
    });
  };

  init();
})();
