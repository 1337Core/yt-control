import { useEffect, useRef } from "react"

import { createPopupController } from "~lib/popup-controller"

import "./popup.css"

const Logo = () => (
  <svg
    className="logo"
    viewBox="0 0 128 128"
    role="img"
    aria-label="YT Control icon">
    <defs>
      <linearGradient id="yt-control-ring" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#ff4242" />
        <stop offset="100%" stopColor="#d81313" />
      </linearGradient>
    </defs>

    <circle cx="64" cy="64" r="56" fill="#111" />
    <circle
      cx="64"
      cy="64"
      r="50"
      fill="none"
      stroke="url(#yt-control-ring)"
      strokeWidth="8"
    />

    <path
      d="M64 26 A38 38 0 0 1 98 52"
      stroke="#fff"
      strokeWidth="6"
      strokeLinecap="round"
      fill="none"
      opacity="0.9"
    />
    <path
      d="M64 26 A38 38 0 0 0 30 52"
      stroke="#fff"
      strokeWidth="6"
      strokeLinecap="round"
      fill="none"
      opacity="0.35"
    />

    <circle cx="64" cy="64" r="6" fill="#fff" />
    <path d="M64 64 L90 44" stroke="#ff5959" strokeWidth="6" strokeLinecap="round" />

    <path d="M49 84 L49 46 L82 65 Z" fill="#fff" opacity="0.92" />
  </svg>
)

function IndexPopup() {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => createPopupController(rootRef.current), [])

  return (
    <div className="popup-app" ref={rootRef}>
      <main className="panel">
        <header className="title-row">
          <Logo />
          <div>
            <h1>YT Control</h1>
          </div>
        </header>

        <section className="section" aria-label="Playback speed controls">
          <div className="label-row">
            <label htmlFor="rateInput">Speed</label>
            <output id="rateValue" htmlFor="rateInput">
              1x
            </output>
          </div>
          <input
            id="rateInput"
            className="slider"
            type="range"
            min="0.1"
            max="8"
            step="0.05"
            defaultValue="1"
            title="Double-click to reset to 1x"
          />
          <div className="range-meta" aria-hidden="true">
            <span>0.1</span>
            <span>8x</span>
          </div>
        </section>

        <section className="section" aria-label="Delay controls">
          <div className="label-row">
            <label htmlFor="delayInput">Delay</label>
            <output id="delayValue" htmlFor="delayInput">
              0 ms
            </output>
          </div>
          <input
            id="delayInput"
            className="slider"
            type="range"
            min="0"
            max="2500"
            step="10"
            defaultValue="0"
          />
          <div className="range-meta" aria-hidden="true">
            <span>0</span>
            <span>2500 ms</span>
          </div>

          <div className="mic-row">
            <label htmlFor="micInputSelect">Mic</label>
            <div className="mic-input-row">
              <select id="micInputSelect" aria-label="Microphone input" />
              <button id="refreshMicInputsBtn" type="button">
                Refresh
              </button>
            </div>
          </div>

          <div className="action-row">
            <button id="autoCalibrateBtn" className="soft" type="button">
              Auto
            </button>
            <button id="calibrateBtn" type="button">
              Manual
            </button>
          </div>

          <p id="autoCalibrationStatus" className="calibration-meta auto-calibration-meta">
            Auto uses your mic to estimate delay.
          </p>

          <div id="calibrationPanel" className="calibration-panel" hidden>
            <canvas
              id="calibrationCanvas"
              width={300}
              height={90}
              aria-label="Calibration sweep preview"
            />
            <p id="calibrationStep" className="calibration-meta">
              Click the sweep to place a marker.
            </p>

            <div className="label-row small-gap">
              <label htmlFor="calibrationOffsetRange">Offset</label>
              <output id="calibrationValue" htmlFor="calibrationOffsetRange">
                0 ms
              </output>
            </div>
            <input
              id="calibrationOffsetRange"
              className="slider"
              type="range"
              min="0"
              max="800"
              step="5"
              defaultValue="0"
            />
            <button id="calibrationApplyBtn" type="button">
              Apply Offset
            </button>
          </div>
        </section>

        <p id="status" role="status" aria-live="polite"></p>
      </main>
    </div>
  )
}

export default IndexPopup
