import type { PlasmoCSConfig } from "plasmo"

import {
  DELAY_RANGE,
  RATE_RANGE,
  STORAGE_KEYS,
  normalizeDelay,
  normalizeRate,
  readStorage,
  writeStorage
} from "~lib/settings"

type FrameRecord = {
  bitmap: ImageBitmap
  readyAt: number
}

type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export const config: PlasmoCSConfig = {
  matches: ["*://youtube.com/*", "*://*.youtube.com/*"],
  run_at: "document_idle"
}

const DEFAULT_RATE = RATE_RANGE.defaultValue
const DEFAULT_VIDEO_DELAY_MS = DELAY_RANGE.defaultValue

const USER_INTENT_WINDOW_MS = 1200
const REAPPLY_DELAY_MS = 200
const TIMELINE_EVENTS = [
  "seeking",
  "ratechange",
  "loadedmetadata",
  "emptied"
] as const
const NAVIGATION_EVENTS = [
  "yt-navigate-finish",
  "yt-page-data-updated",
  "spfdone"
] as const

const trackedVideos = new WeakSet<HTMLVideoElement>()
const delayedRenderers = new WeakMap<HTMLVideoElement, DelayedVideoRenderer>()

let desiredRate: number = DEFAULT_RATE
let desiredVideoDelayMs: number = DEFAULT_VIDEO_DELAY_MS
let lastUserIntentAt = 0
let reapplyTimer: number | undefined

const hasOwn = <T extends object>(
  object: T,
  key: PropertyKey
): key is keyof T => Object.prototype.hasOwnProperty.call(object, key)

const isPlayerPage = (): boolean => {
  const path = location.pathname || ""

  return (
    path.startsWith("/watch") ||
    path.startsWith("/shorts") ||
    path.startsWith("/embed/")
  )
}

const loadSettings = (): Promise<{
  rate: number
  videoDelayMs: number
}> =>
  readStorage([STORAGE_KEYS.rate, STORAGE_KEYS.videoDelayMs], (stored) => ({
    rate: normalizeRate(stored[STORAGE_KEYS.rate]),
    videoDelayMs: normalizeDelay(stored[STORAGE_KEYS.videoDelayMs])
  }))

const saveRate = (rate: number): void => {
  void writeStorage({ [STORAGE_KEYS.rate]: normalizeRate(rate) })
}

const applyRate = (video: HTMLVideoElement): void => {
  if (video.playbackRate === desiredRate) {
    return
  }

  try {
    video.playbackRate = desiredRate
  } catch {}
}

const scheduleReapply = (video: HTMLVideoElement): void => {
  if (reapplyTimer) {
    clearTimeout(reapplyTimer)
  }

  reapplyTimer = window.setTimeout(() => {
    applyRate(video)
  }, REAPPLY_DELAY_MS)
}

const handleRateChange = (video: HTMLVideoElement): void => {
  const rate = normalizeRate(video.playbackRate)

  if (rate === desiredRate) {
    return
  }

  const isUserChange = Date.now() - lastUserIntentAt < USER_INTENT_WINDOW_MS

  if (isUserChange) {
    desiredRate = rate
    saveRate(rate)
  } else {
    scheduleReapply(video)
  }
}

class DelayedVideoRenderer {
  private video: VideoWithFrameCallbacks

  private delayMs: number = DEFAULT_VIDEO_DELAY_MS

  private enabled = false

  private canvas: HTMLCanvasElement | null = null

  private ctx: CanvasRenderingContext2D | null = null

  private parent: HTMLElement | null = null

  private frameQueue: FrameRecord[] = []

  private currentFrame: FrameRecord | null = null

  private captureInFlight = false

  private captureFailures = 0

  private videoFrameRequestId: number | null = null

  private renderRequestId: number | null = null

  private fallbackCaptureInterval: number | null = null

  private layoutInterval: number | null = null

  private resizeObserver: ResizeObserver | null = null

  private originalVideoOpacity = ""

  private originalVideoVisibility = ""

  private originalParentPosition = ""

  private parentPositionAdjusted = false

  private videoHidden = false

  constructor(video: HTMLVideoElement) {
    this.video = video

    this.onVideoFrame = this.onVideoFrame.bind(this)
    this.onRenderFrame = this.onRenderFrame.bind(this)
    this.onTimelineMutation = this.onTimelineMutation.bind(this)
    this.onLayoutChange = this.onLayoutChange.bind(this)
  }

  setDelay(delayMs: number): void {
    const nextDelay = normalizeDelay(delayMs)

    if (nextDelay === this.delayMs && (nextDelay === 0 || this.enabled)) {
      return
    }

    const hasChanged = nextDelay !== this.delayMs
    this.delayMs = nextDelay

    if (this.delayMs <= 0) {
      this.disable()
      return
    }

    this.enable()

    if (hasChanged) {
      this.clearFrames()
    }
  }

  private enable(): void {
    if (
      this.enabled ||
      !this.video.isConnected ||
      !(this.video.parentElement instanceof HTMLElement)
    ) {
      return
    }

    this.parent = this.video.parentElement
    const parentStyle = window.getComputedStyle(this.parent)
    this.originalParentPosition = this.parent.style.position

    if (parentStyle.position === "static") {
      this.parent.style.position = "relative"
      this.parentPositionAdjusted = true
    }

    this.ensureCanvas()
    this.insertCanvas()
    this.syncCanvasLayout()

    this.originalVideoOpacity = this.video.style.opacity
    this.originalVideoVisibility = this.video.style.visibility
    this.setVideoHidden(false)

    for (const eventName of TIMELINE_EVENTS) {
      this.video.addEventListener(eventName, this.onTimelineMutation, {
        passive: true
      })
    }

    this.resizeObserver = new ResizeObserver(this.onLayoutChange)
    this.resizeObserver.observe(this.video)
    this.resizeObserver.observe(this.parent)
    this.layoutInterval = window.setInterval(this.onLayoutChange, 500)

    this.enabled = true
    this.requestVideoFrames()
    this.renderRequestId = requestAnimationFrame(this.onRenderFrame)
  }

  disable(): void {
    if (!this.enabled && !this.canvas) {
      return
    }

    this.enabled = false

    if (
      this.videoFrameRequestId !== null &&
      typeof this.video.cancelVideoFrameCallback === "function"
    ) {
      this.video.cancelVideoFrameCallback(this.videoFrameRequestId)
    }

    this.videoFrameRequestId = null

    if (this.renderRequestId !== null) {
      cancelAnimationFrame(this.renderRequestId)
    }

    this.renderRequestId = null

    if (this.fallbackCaptureInterval !== null) {
      clearInterval(this.fallbackCaptureInterval)
    }

    this.fallbackCaptureInterval = null

    if (this.layoutInterval !== null) {
      clearInterval(this.layoutInterval)
    }

    this.layoutInterval = null

    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    for (const eventName of TIMELINE_EVENTS) {
      this.video.removeEventListener(eventName, this.onTimelineMutation)
    }

    this.clearFrames()

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas)
    }

    this.setVideoHidden(false)

    if (this.parent && this.parentPositionAdjusted) {
      this.parent.style.position = this.originalParentPosition
    }

    this.parentPositionAdjusted = false
    this.parent = null
  }

  private ensureCanvas(): void {
    if (this.canvas) {
      return
    }

    this.canvas = document.createElement("canvas")
    this.canvas.className = "yt-control-delay-canvas"

    Object.assign(this.canvas.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      pointerEvents: "none"
    })

    this.ctx =
      this.canvas.getContext("2d", {
        alpha: false,
        desynchronized: true
      }) ?? this.canvas.getContext("2d")
  }

  private insertCanvas(): void {
    if (!this.canvas || this.canvas.parentElement === this.video.parentElement) {
      return
    }

    this.video.insertAdjacentElement("afterend", this.canvas)
  }

  private onLayoutChange(): void {
    this.syncCanvasLayout()
  }

  private syncCanvasLayout(): void {
    if (!this.canvas || !this.video.isConnected) {
      return
    }

    const width = Math.max(1, this.video.clientWidth || 0)
    const height = Math.max(1, this.video.clientHeight || 0)

    this.canvas.style.left = `${this.video.offsetLeft || 0}px`
    this.canvas.style.top = `${this.video.offsetTop || 0}px`
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`

    const dpr = window.devicePixelRatio || 1
    const backingWidth = Math.max(1, Math.round(width * dpr))
    const backingHeight = Math.max(1, Math.round(height * dpr))

    if (
      this.canvas.width !== backingWidth ||
      this.canvas.height !== backingHeight
    ) {
      this.canvas.width = backingWidth
      this.canvas.height = backingHeight
    }
  }

  private requestVideoFrames(): void {
    if (!this.enabled) {
      return
    }

    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.videoFrameRequestId =
        this.video.requestVideoFrameCallback(this.onVideoFrame)
    } else {
      this.fallbackCaptureInterval = window.setInterval(() => {
        this.captureFrame(performance.now())
      }, 33)
    }
  }

  private onVideoFrame(now: number): void {
    if (!this.enabled) {
      return
    }

    this.captureFrame(now)
    this.requestVideoFrames()
  }

  private captureFrame(capturedAt: number): void {
    if (
      !this.enabled ||
      this.captureInFlight ||
      !this.video.isConnected ||
      this.video.readyState < 2 ||
      typeof createImageBitmap !== "function"
    ) {
      return
    }

    this.captureInFlight = true

    void createImageBitmap(this.video)
      .then((bitmap) => {
        if (!this.enabled) {
          bitmap.close()
          return
        }

        this.captureFailures = 0
        this.frameQueue.push({
          bitmap,
          readyAt: capturedAt + this.delayMs
        })

        this.trimFrameQueue()
      })
      .catch(() => {
        this.captureFailures += 1

        if (this.captureFailures >= 16) {
          this.disable()
        }
      })
      .finally(() => {
        this.captureInFlight = false
      })
  }

  private trimFrameQueue(): void {
    const maxFrames = Math.max(
      10,
      Math.min(180, Math.ceil(this.delayMs / 16) + 10)
    )

    while (this.frameQueue.length > maxFrames) {
      const dropped = this.frameQueue.shift()
      dropped?.bitmap.close()
    }
  }

  private onRenderFrame(): void {
    if (!this.enabled) {
      return
    }

    if (!this.video.isConnected) {
      this.disable()
      return
    }

    const now = performance.now()
    let nextFrame: FrameRecord | null = null

    while (this.frameQueue.length > 0 && this.frameQueue[0].readyAt <= now) {
      nextFrame = this.frameQueue.shift() ?? null
    }

    if (nextFrame) {
      this.currentFrame?.bitmap.close()
      this.currentFrame = nextFrame
    }

    if (this.currentFrame && this.ctx && this.canvas) {
      this.setVideoHidden(true)

      try {
        this.ctx.drawImage(
          this.currentFrame.bitmap,
          0,
          0,
          this.canvas.width,
          this.canvas.height
        )
      } catch {}
    } else {
      this.setVideoHidden(false)
    }

    this.renderRequestId = requestAnimationFrame(this.onRenderFrame)
  }

  private onTimelineMutation(): void {
    this.clearFrames()
  }

  private clearFrames(): void {
    for (const frame of this.frameQueue) {
      frame.bitmap.close()
    }

    this.frameQueue.length = 0
    this.currentFrame?.bitmap.close()
    this.currentFrame = null

    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }

    this.setVideoHidden(false)
  }

  private setVideoHidden(hidden: boolean): void {
    if (hidden === this.videoHidden) {
      return
    }

    this.videoHidden = hidden

    if (hidden) {
      this.video.style.opacity = "0"
      this.video.style.visibility = "visible"
      return
    }

    this.video.style.opacity = this.originalVideoOpacity
    this.video.style.visibility = this.originalVideoVisibility
  }
}

const getRenderer = (video: HTMLVideoElement): DelayedVideoRenderer => {
  let renderer = delayedRenderers.get(video)

  if (!renderer) {
    renderer = new DelayedVideoRenderer(video)
    delayedRenderers.set(video, renderer)
  }

  return renderer
}

const applyVideoDelay = (video: HTMLVideoElement): void => {
  getRenderer(video).setDelay(desiredVideoDelayMs)
}

const syncVideo = (video: HTMLVideoElement): void => {
  applyRate(video)
  applyVideoDelay(video)
}

const attach = (video: HTMLVideoElement): boolean => {
  if (trackedVideos.has(video)) {
    return false
  }

  trackedVideos.add(video)

  const reapply = (): void => {
    applyRate(video)
  }

  video.addEventListener("loadedmetadata", reapply, { passive: true })
  video.addEventListener("play", reapply, { passive: true })
  video.addEventListener("ratechange", () => handleRateChange(video), {
    passive: true
  })

  return true
}

const forEachPlayerVideo = (
  callback: (video: HTMLVideoElement) => void
): void => {
  if (!isPlayerPage()) {
    return
  }

  document.querySelectorAll<HTMLVideoElement>("video").forEach(callback)
}

const scan = (): void => {
  forEachPlayerVideo((video) => {
    attach(video)
    syncVideo(video)
  })
}

const syncTrackedVideos = (): void => {
  forEachPlayerVideo(syncVideo)
}

const listenStorageChanges = (): void => {
  if (!chrome.storage?.onChanged) {
    return
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return
    }

    let shouldRescan = false

    if (hasOwn(changes, STORAGE_KEYS.rate)) {
      desiredRate = normalizeRate(changes[STORAGE_KEYS.rate]?.newValue)
      shouldRescan = true
    }

    if (hasOwn(changes, STORAGE_KEYS.videoDelayMs)) {
      desiredVideoDelayMs = normalizeDelay(
        changes[STORAGE_KEYS.videoDelayMs]?.newValue
      )
      shouldRescan = true
    }

    if (shouldRescan) {
      syncTrackedVideos()
    }
  })
}

const syncAddedNode = (node: Node): void => {
  if (node instanceof HTMLVideoElement) {
    attach(node)
    syncVideo(node)
    return
  }

  if (node instanceof Element) {
    node.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
      attach(video)
      syncVideo(video)
    })
  }
}

const observe = (): void => {
  const root = document.documentElement

  if (!root) {
    return
  }

  const observer = new MutationObserver((mutations) => {
    if (!isPlayerPage()) {
      return
    }

    for (const mutation of mutations) {
      mutation.addedNodes.forEach(syncAddedNode)
    }
  })

  observer.observe(root, { childList: true, subtree: true })
}

const recordUserIntent = (event: Event): void => {
  const target = event.target

  if (!(target instanceof HTMLElement)) {
    lastUserIntentAt = Date.now()
    return
  }

  const tag = target.tagName

  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  ) {
    return
  }

  lastUserIntentAt = Date.now()
}

const listenUserIntent = (): void => {
  document.addEventListener("keydown", recordUserIntent, true)
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target

      if (
        target instanceof Element &&
        (target.closest("video") || target.closest(".html5-video-player"))
      ) {
        recordUserIntent(event)
      }
    },
    true
  )
}

const listenNavigation = (): void => {
  const onNavigate = (): void => {
    scan()
  }

  for (const eventName of NAVIGATION_EVENTS) {
    window.addEventListener(eventName, onNavigate, true)
  }
}

const init = async (): Promise<void> => {
  const settings = await loadSettings()
  desiredRate = settings.rate
  desiredVideoDelayMs = settings.videoDelayMs

  scan()
  observe()
  listenNavigation()
  listenUserIntent()
  listenStorageChanges()
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void init()
  }, { once: true })
} else {
  void init()
}
