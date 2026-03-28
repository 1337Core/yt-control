import { Storage } from "@plasmohq/storage"

export const storage = new Storage({
  area: "local"
})

export const STORAGE_KEYS = Object.freeze({
  rate: "yt_control_playback_rate",
  videoDelayMs: "yt_control_video_delay_ms",
  micDeviceId: "yt_control_mic_device_id"
})

export const RATE_RANGE = Object.freeze({
  defaultValue: 1,
  min: 0.1,
  max: 8
})

export const DELAY_RANGE = Object.freeze({
  defaultValue: 0,
  min: 0,
  max: 2500
})

const clampNumber = (
  value,
  { defaultValue, min, max, rejectZeroOrLess = false }
) => {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || (rejectZeroOrLess && parsed <= 0)) {
    return defaultValue
  }

  return Math.min(max, Math.max(min, parsed))
}

export const normalizeRate = (value) =>
  clampNumber(value, {
    ...RATE_RANGE,
    rejectZeroOrLess: true
  })

export const normalizeDelay = (value) => clampNumber(value, DELAY_RANGE)

export const toDisplayRate = (value) =>
  String(Math.round(normalizeRate(value) * 100) / 100)

export const toDisplayDelay = (value) => String(normalizeDelay(value))

export const readStorage = async (keys, mapResult) => {
  try {
    const entries = await Promise.all(keys.map(async (key) => [key, await storage.get(key)]))
    return mapResult(Object.fromEntries(entries))
  } catch (error) {
    return mapResult({})
  }
}

export const writeStorage = async (values, onComplete) => {
  try {
    await Promise.all(
      Object.entries(values).map(([key, value]) => storage.set(key, value))
    )
  } finally {
    onComplete?.()
  }
}
