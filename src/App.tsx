/**
 * teslacam.cscloud.dk
 *
 * A viewer for your own dashcam footage that never uploads a frame. The server
 * hosts this page; everything else - reading the folder, decoding the video,
 * pulling telemetry out of the bitstream, composing an export - happens in the
 * browser on your machine.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import ExportPanel from './components/ExportPanel'
import Library from './components/Library'
import Picker from './components/Picker'
import Player from './components/Player'
import type { LayoutName, OverlayOptions, Unit } from './lib/compose'
import {
  CAMERA_LABEL, CAMERAS, camerasIn, eventSeconds,
  type Camera, type TeslaEvent,
} from './lib/library'
import { speedIn, type Telemetry } from './lib/sei'

const LAYOUTS: { id: LayoutName; da: string }[] = [
  { id: 'tesla', da: 'Bilens layout' },
  { id: 'grid', da: 'Gitter' },
  { id: 'wide', da: 'På række' },
  { id: 'single', da: 'Ét kamera' },
]

const RATES = [0.5, 1, 2, 4] as const

export default function App() {
  const [library, setLibrary] = useState<TeslaEvent[] | null>(null)
  const [selected, setSelected] = useState<TeslaEvent | null>(null)
  const [cameras, setCameras] = useState<Camera[]>([...CAMERAS])
  const [layout, setLayout] = useState<LayoutName>('tesla')
  const [unit, setUnit] = useState<Unit>('kmh')
  const [overlay, setOverlay] = useState<Omit<OverlayOptions, 'unit'>>({
    speed: true, clock: true, gear: true, place: true, labels: true,
  })

  const [playing, setPlaying] = useState(true)
  const [rate, setRate] = useState<number>(1)
  const [time, setTime] = useState(0)
  const [total, setTotal] = useState(0)
  const [seekTo, setSeekTo] = useState<number | null>(null)
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [noTelemetry, setNoTelemetry] = useState(false)
  const [exporting, setExporting] = useState(false)

  const opts: OverlayOptions = useMemo(() => ({ ...overlay, unit }), [overlay, unit])
  const available = selected ? camerasIn(selected) : []

  // Rendered often; a new function per render would restart the player's loop.
  const onTime = useCallback((t: number, tot: number) => { setTime(t); setTotal(tot) }, [])
  const onTelemetry = useCallback((t: Telemetry | null, empty: boolean) => {
    setTelemetry(t); setNoTelemetry(empty)
  }, [])

  const openEvent = (e: TeslaEvent) => {
    setSelected(e)
    setCameras(camerasIn(e))
    setTime(0)
    setSeekTo(0)
    setPlaying(true)
  }

  if (!library) return <Picker onLoaded={(evts) => setLibrary(evts)} />

  if (!selected) {
    return (
      <Library events={library} onOpen={openEvent} onReset={() => setLibrary(null)} />
    )
  }

  const duration = total || eventSeconds(selected)

  return (
    <div className="mx-auto max-w-6xl px-3 pb-16 pt-3 sm:px-5">
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <button className="btn" onClick={() => { setSelected(null); setPlaying(false) }}>
          ← Alle optagelser
        </button>
        <div className="min-w-0">
          <p className="truncate font-medium">{titleOf(selected)}</p>
          <p className="num truncate text-xs text-faint">
            {selected.segments.length} klip · {Math.round(duration)} sekunder
            {selected.meta?.city ? ` · ${selected.meta.city}` : ''}
          </p>
        </div>
      </header>

      {/* The player is unmounted while exporting, not merely paused. Four
          <video> elements hold four decoders, and the browser allows only so
          many at once - with them alive the exporter's own VideoDecoder never
          produced a frame and the job sat at 0% forever. Nothing to watch
          during an export anyway. */}
      {exporting ? (
        <div className="grid aspect-[2/1] w-full place-content-center rounded-xl border border-line bg-surface text-center text-muted">
          <p>Eksporterer…</p>
          <p className="mt-1 text-sm text-faint">Afspilningen er sat på pause så længe.</p>
        </div>
      ) : (
        <Player
          event={selected}
          cameras={cameras}
          layout={layout}
          overlay={opts}
          lang="da"
          onTime={onTime}
          onTelemetry={onTelemetry}
          seekTo={seekTo}
          playing={playing}
          rate={rate}
          onEnded={() => setPlaying(false)}
        />
      )}

      {/* Transport */}
      <div className="card mt-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <button className="btn shrink-0" onClick={() => setPlaying(!playing)}
                  aria-label={playing ? 'Pause' : 'Afspil'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input
            type="range" className="scrub"
            min={0} max={Math.max(1, duration)} step={0.1}
            value={Math.min(time, duration)}
            onChange={(e) => { setPlaying(false); setSeekTo(Number(e.target.value)) }}
            aria-label="Position"
          />
          <span className="num shrink-0 text-sm text-muted">
            {clock(time)} / {clock(duration)}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-1.5">
            <span className="eyebrow">Fart</span>
            {RATES.map((r) => (
              <button key={r} className="chip" aria-pressed={rate === r}
                      onClick={() => setRate(r)}>{r}×</button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="eyebrow">Kameraer</span>
            {available.map((cam) => (
              <button key={cam} className="chip" aria-pressed={cameras.includes(cam)}
                      onClick={() => setCameras((c) =>
                        c.includes(cam) ? c.filter((x) => x !== cam) : [...c, cam])}>
                {CAMERA_LABEL[cam].da}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="eyebrow">Layout</span>
            <select className="chip !px-2" value={layout}
                    onChange={(e) => setLayout(e.target.value as LayoutName)}>
              {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.da}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Readout and overlay switches */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="card px-4 py-3">
          <h2 className="eyebrow">Telemetri</h2>
          {noTelemetry ? (
            <p className="mt-2 text-sm text-muted">
              Denne optagelse har ingen telemetri. Bilen skriver fart, gear og GPS
              ind i videoen fra firmware 2025.44.25 — ældre klip har det ikke.
            </p>
          ) : telemetry ? (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <p className="num text-3xl">
                {speedIn(unit, telemetry.speedMps)}
                <span className="ml-1 text-sm text-muted">{unit === 'kmh' ? 'km/t' : 'mph'}</span>
              </p>
              <p className="num text-sm text-muted">
                Gear {telemetry.gear === 'reverse' ? 'R'
                  : telemetry.gear === 'drive' ? 'D'
                  : telemetry.gear === 'park' ? 'P' : 'N'}
              </p>
              <p className="num text-sm text-muted">Rat {telemetry.steeringDeg.toFixed(0)}°</p>
              {telemetry.braking && <p className="text-sm text-warn">Bremser</p>}
              {telemetry.blinkerLeft && <p className="text-sm text-warn">Blink venstre</p>}
              {telemetry.blinkerRight && <p className="text-sm text-warn">Blink højre</p>}
              {telemetry.autopilot !== 'none' && (
                <p className="text-sm text-live">{apLabel(telemetry.autopilot)}</p>
              )}
              <p className="num w-full text-xs text-faint">
                {telemetry.lat.toFixed(5)}, {telemetry.lon.toFixed(5)}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-faint">
              Ingen data på dette tidspunkt — bilen holdt formentlig stille.
            </p>
          )}
        </div>

        <div className="card px-4 py-3">
          <h2 className="eyebrow">Vis på billedet</h2>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {([
              ['speed', 'Fart'], ['gear', 'Gear'], ['clock', 'Dato og tid'],
              ['place', 'Sted'], ['labels', 'Kameranavne'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={overlay[key]}
                       onChange={(e) => setOverlay({ ...overlay, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <span className="eyebrow">Enhed</span>
            <button className="chip" aria-pressed={unit === 'kmh'}
                    onClick={() => setUnit('kmh')}>km/t</button>
            <button className="chip" aria-pressed={unit === 'mph'}
                    onClick={() => setUnit('mph')}>mph</button>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <button className="btn btn-primary" onClick={() => { setPlaying(false); setExporting(true) }}>
          Eksportér som video
        </button>
      </div>

      {exporting && (
        <ExportPanel
          event={selected}
          cameras={cameras}
          layout={layout}
          overlay={opts}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  )
}

function titleOf(e: TeslaEvent): string {
  const when = e.startedAt.toLocaleString('da-DK', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  })
  return when.charAt(0).toUpperCase() + when.slice(1)
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function apLabel(state: string): string {
  return state === 'self_driving' ? 'FSD'
    : state === 'autosteer' ? 'Autostyring'
    : state === 'tacc' ? 'Fartpilot' : ''
}
