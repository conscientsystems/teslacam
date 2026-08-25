/**
 * The timeline you cut on.
 *
 * One track for the whole event, with the segment boundaries drawn on it, a
 * playhead, and two handles that select what gets exported. The range used to
 * be two dropdowns in a modal listing whole one-minute files - so exporting a
 * four-second near-miss produced a minute of driving around it, and you had to
 * leave the picture to say which minute you meant.
 *
 * Three ways to set the same two numbers, because they suit different moments:
 * drag a handle when you can see what you want, press I and O while watching,
 * or click the buttons under the track. All three write to the same state.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { EventAction, TeslaEvent } from '../lib/library'
import type { ActionKind } from '../lib/sei'

/** What each manoeuvre is called, and the colour that marks it. Amber for the
 *  indicators (as the car's own tell-tale), red for braking, orange for
 *  reversing, teal for autopilot on (the app's live colour), grey for off. */
const ACTION_LABEL: Record<ActionKind, string> = {
  blinker_left: 'Blink venstre',
  blinker_right: 'Blink højre',
  brake: 'Bremser',
  reverse: 'Bakker',
  autopilot_on: 'Autopilot til',
  autopilot_off: 'Autopilot fra',
}
const ACTION_COLOR: Record<ActionKind, string> = {
  blinker_left: '#e8a33d',
  blinker_right: '#e8a33d',
  brake: '#ef4444',
  reverse: '#f97316',
  autopilot_on: '#5ad1c4',
  autopilot_off: '#7d8a8f',
}
/** Order the legend and stack markers by, so overlapping markers show the more
 *  notable manoeuvre on top. */
const ACTION_ORDER: ActionKind[] = [
  'brake', 'reverse', 'autopilot_on', 'autopilot_off', 'blinker_left', 'blinker_right',
]

export interface TimelineProps {
  event: TeslaEvent
  /** Whole-event seconds. */
  duration: number
  time: number
  inSec: number
  outSec: number
  /** Manoeuvres pulled from telemetry, in whole-event seconds. */
  actions?: EventAction[]
  onSeek: (t: number) => void
  onIn: (t: number) => void
  onOut: (t: number) => void
  /** Back to the whole event - which is not the same as setting the out-point
   *  to today's estimate of the length, because that estimate is still being
   *  measured. */
  onWhole: () => void
  disabled?: boolean
}

type Grab = 'in' | 'out' | 'playhead'

/** Handles closer together than this would overlap and become unpickable. */
const MIN_SELECTION = 0.5

export default function Timeline({
  event, duration, time, inSec, outSec, actions = [], onSeek, onIn, onOut, onWhole, disabled,
}: TimelineProps) {
  const track = useRef<HTMLDivElement>(null)
  const grabbed = useRef<Grab | null>(null)

  const span = Math.max(duration, 0.001)
  const pct = (t: number) => `${Math.max(0, Math.min(1, t / span)) * 100}%`

  const secondsAt = useCallback((clientX: number) => {
    const el = track.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(span, ((clientX - r.left) / r.width) * span))
  }, [span])

  const apply = useCallback((what: Grab, t: number) => {
    if (what === 'playhead') onSeek(t)
    else if (what === 'in') onIn(Math.min(t, outSec - MIN_SELECTION))
    else onOut(Math.max(t, inSec + MIN_SELECTION))
  }, [onSeek, onIn, onOut, inSec, outSec])

  // Dragging continues outside the track, and must survive the pointer leaving
  // the window - otherwise a handle stays stuck to the cursor.
  useEffect(() => {
    if (disabled) return
    const move = (e: PointerEvent) => {
      if (!grabbed.current) return
      e.preventDefault()
      apply(grabbed.current, secondsAt(e.clientX))
    }
    const up = () => { grabbed.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [apply, secondsAt, disabled])

  const grab = (what: Grab) => (e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    grabbed.current = what
    apply(what, secondsAt(e.clientX))
  }

  const nudge = (what: 'in' | 'out') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 5 : e.key === 'PageUp' || e.key === 'PageDown' ? 10 : 1
    const dir = e.key === 'ArrowLeft' || e.key === 'PageDown' ? -1
      : e.key === 'ArrowRight' || e.key === 'PageUp' ? 1 : 0
    if (!dir) return
    e.preventDefault()
    apply(what, (what === 'in' ? inSec : outSec) + dir * step)
  }

  const presentKinds = ACTION_ORDER.filter((k) => actions.some((a) => a.kind === k))
  // Draw the more notable manoeuvres last, so they sit on top where markers overlap.
  const sortedActions = [...actions].sort(
    (a, b) => ACTION_ORDER.indexOf(b.kind) - ACTION_ORDER.indexOf(a.kind),
  )

  return (
    <div className="select-none">
      {/* Manoeuvre markers, above the track so they never sit under the trim
          handles or the scrub area. Click one to jump to it. */}
      {actions.length > 0 && (
        <div className="relative mb-1 h-3.5">
          {sortedActions.map((a, i) => (
            <button
              key={`${a.kind}-${a.atSec.toFixed(2)}-${i}`}
              type="button"
              disabled={disabled}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSeek(a.atSec)}
              title={`${ACTION_LABEL[a.kind]} · ${clock(a.atSec)}`}
              aria-label={`${ACTION_LABEL[a.kind]} ved ${clock(a.atSec)}`}
              className="group absolute bottom-0 -translate-x-1/2 cursor-pointer disabled:cursor-default"
              style={{ left: pct(a.atSec) }}
            >
              <span
                className="block h-2.5 w-2.5 rounded-full ring-1 ring-black/50 transition-transform group-hover:scale-150"
                style={{ background: ACTION_COLOR[a.kind] }}
              />
            </button>
          ))}
        </div>
      )}

      {/* Two layers on purpose. The fills are clipped to the rounded track;
          the handles are not, because the out-handle sits at the very end and
          `overflow-hidden` made its right half unclickable - grabbing it hit
          the track underneath and scrubbed the video instead of trimming. */}
      <div ref={track} className="relative h-14 w-full">
      <div
        onPointerDown={grab('playhead')}
        className="absolute inset-0 cursor-pointer overflow-hidden rounded-lg border border-line bg-raised"
      >
        {/* Segment boundaries: the file the footage comes from is real
            information when a clip is missing a camera or the car restarted. */}
        {event.segments.map((s, i) => {
          const left = event.segments.slice(0, i).reduce((n, x) => n + (x.durationSec ?? 60), 0)
          if (i === 0) return null
          return (
            <div key={s.key} className="absolute top-0 h-full w-px bg-line"
                 style={{ left: pct(left) }} />
          )
        })}

        {/* Everything outside the selection is dimmed rather than hidden: you
            can still see what you are cutting away. */}
        <div className="absolute inset-y-0 left-0 bg-black/55" style={{ width: pct(inSec) }} />
        <div className="absolute inset-y-0 right-0 bg-black/55"
             style={{ left: pct(outSec), right: 0 }} />
        <div className="absolute inset-y-0 border-x-2 border-live bg-live/10"
             style={{ left: pct(inSec), width: pct(outSec - inSec) }} />

        {/* A hairline under each manoeuvre marker, so its position on the track
            is exact. pointer-events-none: they must never block scrubbing. */}
        {sortedActions.map((a, i) => (
          <div key={`line-${a.kind}-${a.atSec.toFixed(2)}-${i}`}
               className="pointer-events-none absolute inset-y-0 w-px opacity-60"
               style={{ left: pct(a.atSec), background: ACTION_COLOR[a.kind] }} />
        ))}

        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
             style={{ left: pct(time) }} />
      </div>

      {/* Handles. Wide targets: this is used on a laptop trackpad. */}
      {([['in', inSec], ['out', outSec]] as const).map(([what, at]) => (
        <div
          key={what}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={what === 'in' ? 'Startmarkør' : 'Slutmarkør'}
          aria-valuemin={0}
          aria-valuemax={Math.round(span)}
          aria-valuenow={Math.round(at)}
          aria-valuetext={clock(at)}
          onPointerDown={grab(what)}
          onKeyDown={nudge(what)}
          className="absolute inset-y-0 z-10 w-5 -translate-x-1/2 cursor-ew-resize
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-live"
          style={{ left: pct(at) }}
        >
          <div className="mx-auto h-full w-1 rounded-full bg-live" />
          <div className="absolute left-1/2 top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-sm bg-live" />
        </div>
      ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button className="chip" onClick={() => onIn(Math.min(time, outSec - MIN_SELECTION))}
                disabled={disabled} title="Tast I">
          [ Start her
        </button>
        <button className="chip" onClick={() => onOut(Math.max(time, inSec + MIN_SELECTION))}
                disabled={disabled} title="Tast O">
          Slut her ]
        </button>
        <button className="chip" onClick={onWhole} disabled={disabled}>
          Hele optagelsen
        </button>
        <p className="num ml-auto text-sm text-muted">
          {clock(inSec)} – {clock(outSec)}
          <span className="ml-2 text-faint">({clock(outSec - inSec)} valgt)</span>
        </p>
      </div>

      {/* Legend: only the manoeuvres this event actually contains. */}
      {presentKinds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {presentKinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: ACTION_COLOR[k] }} />
              {ACTION_LABEL[k]}
            </span>
          ))}
          <span className="text-faint">· klik en markør for at hoppe dertil</span>
        </div>
      )}
    </div>
  )
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
