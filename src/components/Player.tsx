/**
 * Four cameras, one clock.
 *
 * A `<video>` per camera, all seeking together. The first camera present is the
 * timekeeper and the others are nudged back into line when they drift more than
 * a frame or two - browsers do not start several decoders in perfect lockstep,
 * and without correction the back camera ends up half a second ahead by the end
 * of a minute.
 *
 * Segments are separate files, so playing an event means swapping every `src`
 * at each boundary. The next segment is preloaded during the current one, or
 * the swap shows a black frame for as long as it takes to open a 40 MB file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  contain, drawCameraLabel, drawOverlay, layoutFor,
  type LayoutName, type OverlayOptions,
} from '../lib/compose'
import {
  CAMERA_LABEL, camerasIn, locate, segmentStart,
  type Camera, type TeslaEvent,
} from '../lib/library'
import { buildIndex, extractTelemetry, type Telemetry } from '../lib/sei'

const DRIFT_TOLERANCE = 0.08     // seconds before a camera is pulled back

export interface PlayerProps {
  event: TeslaEvent
  cameras: Camera[]
  layout: LayoutName
  overlay: OverlayOptions
  lang: 'da' | 'en'
  onTime: (t: number, total: number) => void
  onTelemetry: (t: Telemetry | null, noTelemetry: boolean) => void
  seekTo: number | null
  playing: boolean
  rate: number
  onEnded: () => void
}

export default function Player({
  event, cameras, layout, overlay, lang,
  onTime, onTelemetry, seekTo, playing, rate, onEnded,
}: PlayerProps) {
  const present = useMemo(() => camerasIn(event).filter((c) => cameras.includes(c)), [event, cameras])
  const boxes = useMemo(() => layoutFor(layout, present), [layout, present])

  const refs = useRef(new Map<Camera, HTMLVideoElement>())
  const hud = useRef<HTMLCanvasElement>(null)
  const [index, setIndex] = useState(0)
  const [urls, setUrls] = useState<Map<Camera, string>>(new Map())
  // A seek that lands in a *different* segment can't be applied now: setIndex
  // swaps every src in a later effect and the videos reload to 0, so the offset
  // has to wait until the new segment's video is ready. Stashed here, applied in
  // onLoadedMetadata below.
  const pendingSeek = useRef<number | null>(null)
  const telemetry = useRef<{ at: ReturnType<typeof buildIndex>; empty: boolean }>({
    at: null, empty: true,
  })

  const segment = event.segments[index]

  // Read the current segment index inside the seek effect without making index a
  // dependency: setIndex would otherwise re-run the effect with the same seekTo
  // and clear pendingSeek before the new segment's video ever loads.
  const indexRef = useRef(index)
  indexRef.current = index

  // ---- object URLs for the current segment, revoked when it changes
  useEffect(() => {
    if (!segment) return
    const made = new Map<Camera, string>()
    for (const cam of present) {
      const file = segment.files[cam]
      if (file) made.set(cam, URL.createObjectURL(file))
    }
    setUrls(made)
    return () => { for (const u of made.values()) URL.revokeObjectURL(u) }
  }, [segment, present])

  // ---- telemetry for the current segment, read off the main thread
  useEffect(() => {
    if (!segment) return
    let cancelled = false
    telemetry.current = { at: null, empty: true }

    // Whichever camera carries the most samples: the back camera of a segment
    // can have fewer than the front, or none at all.
    const candidates = present.map((c) => segment.files[c]).filter(Boolean) as File[]
    if (!candidates.length) return

    ;(async () => {
      let best: Telemetry[] = []
      for (const file of candidates) {
        const { samples } = extractTelemetry(await file.arrayBuffer())
        if (samples.length > best.length) best = samples
        if (best.length) break        // the first camera with data is enough
      }
      if (cancelled) return
      telemetry.current = { at: buildIndex(best), empty: best.length === 0 }
    })()

    return () => { cancelled = true }
  }, [segment, present])

  // ---- the timekeeper drives everything else
  const lead = present[0]

  const syncOthers = useCallback((t: number) => {
    for (const cam of present) {
      if (cam === lead) continue
      const el = refs.current.get(cam)
      if (!el || el.readyState < 2) continue
      if (Math.abs(el.currentTime - t) > DRIFT_TOLERANCE) el.currentTime = t
    }
  }, [present, lead])

  useEffect(() => {
    for (const el of refs.current.values()) el.playbackRate = rate
  }, [rate, urls])

  useEffect(() => {
    for (const [cam, el] of refs.current) {
      if (!present.includes(cam)) continue
      if (playing) void el.play().catch(() => {})
      else el.pause()
    }
  }, [playing, urls, present])

  // ---- an outside seek, in whole-event seconds. Keyed on seekTo/event only:
  // see indexRef above for why index is deliberately not a dependency.
  useEffect(() => {
    if (seekTo === null) return
    const { index: i, offset } = locate(event, seekTo)
    if (i !== indexRef.current) {
      // Different segment: defer the offset until the new segment loads,
      // otherwise it lands on the old file and the new one starts at 0 - the
      // "jump to a point in another segment is unstable" bug.
      pendingSeek.current = offset
      setIndex(i)
    } else {
      pendingSeek.current = null
      for (const el of refs.current.values()) {
        if (el.readyState >= 1) el.currentTime = offset
      }
    }
  }, [seekTo, event])

  // ---- the HUD, drawn on a canvas over the videos
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = lead ? refs.current.get(lead) : null
      const canvas = hud.current
      if (!el || !canvas) return

      const t = el.currentTime
      syncOthers(t)

      const total = event.segments.reduce((n, s) => n + (s.durationSec ?? 60), 0)
      onTime(segmentStart(event, index) + t, total)

      const sample = telemetry.current.at ? telemetry.current.at(t) : null
      onTelemetry(sample, telemetry.current.empty)

      // Match the backing store to the displayed size, or the HUD is blurry on
      // a high-DPI screen and misplaced after a resize.
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(rect.width * dpr)
      const h = Math.round(rect.height * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)

      if (overlay.labels) {
        for (const [cam, box] of boxes) drawCameraLabel(ctx, cam, box, { w, h }, lang)
      }
      drawOverlay(ctx, { w, h }, {
        telemetry: sample,
        at: new Date(segment ? segment.startedAt.getTime() + t * 1000 : Date.now()),
        place: event.meta?.city,
        noTelemetry: telemetry.current.empty,
      }, overlay, lang)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lead, boxes, overlay, lang, event, index, segment, onTime, onTelemetry, syncOthers])

  const advance = () => {
    if (index + 1 < event.segments.length) {
      setIndex(index + 1)
      // The new sources autoplay below; without this the player stops between
      // every minute of a ten-minute event.
    } else {
      onEnded()
    }
  }

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-black"
         style={{ aspectRatio: layout === 'tesla' && present.length === 4 ? '4 / 3' : undefined }}>
      <div className="relative h-full w-full" style={{ aspectRatio: aspectFor(layout, present.length) }}>
        {present.map((cam) => {
          const box = boxes.get(cam)
          if (!box) return null
          return (
            <video
              key={cam}
              ref={(el) => { if (el) refs.current.set(cam, el); else refs.current.delete(cam) }}
              src={urls.get(cam)}
              muted
              playsInline
              preload="auto"
              // The timekeeper reports the end of a segment; the others just
              // follow, so only one advance fires.
              onEnded={cam === lead ? advance : undefined}
              onLoadedMetadata={(e) => {
                if (cam !== lead) return
                const d = e.currentTarget.duration
                if (Number.isFinite(d)) segment && (segment.durationSec = d)
                // Apply a seek that was waiting for this segment to load. Set the
                // lead here and every camera that's ready; the rest are pulled
                // into line by syncOthers on the next frame.
                if (pendingSeek.current !== null) {
                  const off = pendingSeek.current
                  pendingSeek.current = null
                  e.currentTarget.currentTime = off
                  for (const el of refs.current.values()) {
                    if (el.readyState >= 1) el.currentTime = off
                  }
                }
                if (playing) void e.currentTarget.play().catch(() => {})
              }}
              className="absolute object-contain"
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
              }}
            />
          )
        })}
        <canvas ref={hud} className="pointer-events-none absolute inset-0 h-full w-full" />
      </div>

      {!present.length && (
        <p className="absolute inset-0 grid place-content-center text-faint">
          Vælg mindst ét kamera
        </p>
      )}
    </div>
  )
}

/** The shape of the composed view, so the container does not letterbox twice. */
function aspectFor(layout: LayoutName, n: number): string {
  if (n === 0) return '4 / 3'
  if (layout === 'tesla' && n === 4) return '2 / 1'
  if (layout === 'single' || n === 1) return '4 / 3'
  if (layout === 'wide') return `${(4 * n)} / 3`
  const cols = n <= 2 ? n : 2
  const rows = Math.ceil(n / cols)
  return `${4 * cols} / ${3 * rows}`
}

export { CAMERA_LABEL }
