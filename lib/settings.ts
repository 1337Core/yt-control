import { Storage } from "@plasmohq/storage"

export const storage = new Storage({
  area: "local"
})

export const STORAGE_KEYS = Object.freeze({
  rate: "yt_control_playback_rate",
  videoDelayMs: "yt_control_video_delay_ms",
  micDeviceId: "yt_control_mic_device_id"
})

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]

export type StoredSettings = {
  [STORAGE_KEYS.rate]?: number
  [STORAGE_KEYS.videoDelayMs]?: number
  [STORAGE_KEYS.micDeviceId]?: string
}

type NumberRange = {
  defaultValue: number
  min: number
  max: number
}

type ClampOptions = NumberRange & {
  rejectZeroOrLess?: boolean
}

export const RATE_RANGE = Object.freeze({
  defaultValue: 1,
  min: 0.1,
  max: 8
}) satisfies NumberRange

export const DELAY_RANGE = Object.freeze({
  defaultValue: 0,
  min: 0,
  max: 2500
}) satisfies NumberRange

const clampNumber = (value: unknown, options: ClampOptions): number => {
  const { defaultValue, min, max, rejectZeroOrLess = false } = options
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || (rejectZeroOrLess && parsed <= 0)) {
    return defaultValue
  }

  return Math.min(max, Math.max(min, parsed))
}

export const normalizeRate = (value: unknown): number =>
  clampNumber(value, {
    ...RATE_RANGE,
    rejectZeroOrLess: true
  })

export const normalizeDelay = (value: unknown): number =>
  clampNumber(value, DELAY_RANGE)

export const toDisplayRate = (value: unknown): string =>
  String(Math.round(normalizeRate(value) * 100) / 100)

export const toDisplayDelay = (value: unknown): string =>
  String(normalizeDelay(value))

export const readStorage = async <T>(
  keys: readonly StorageKey[],
  mapResult: (stored: StoredSettings) => T
): Promise<T> => {
  try {
    const entries = await Promise.all(
      keys.map(async (key) => [key, await storage.get(key)] as const)
    )

    return mapResult(Object.fromEntries(entries) as StoredSettings)
  } catch {
    return mapResult({})
  }
}

export const writeStorage = async (
  values: Partial<StoredSettings>,
  onComplete?: () => void
): Promise<void> => {
  try {
    await Promise.all(
      Object.entries(values).map(([key, value]) =>
        storage.set(key as StorageKey, value)
      )
    )
  } finally {
    onComplete?.()
  }
}
