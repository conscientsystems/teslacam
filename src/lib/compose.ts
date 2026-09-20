/**
 * Where each camera goes, and what the overlay looks like.
 *
 * Shared between the on-screen player and the exporter, deliberately: an
 * export that does not look like what you were watching is a bug report
 * waiting to happen. The player positions DOM elements with these rectangles;
 * the exporter draws into a canvas with the same ones.
 */

import { CAMERA_LABEL, type Camera } from './library'
import { speedIn, type Telemetry } from './sei'

export type LayoutName = 'tesla' | 'grid' | 'wide' | 'single'
export type Unit = 'kmh' | 'mph'

export interface Rect { x: number; y: number; w: number; h: number }

export interface OverlayOptions {
  speed: boolean
  unit: Unit
  clock: boolean
  gear: boolean
  place: boolean
  labels: boolean
}

/** Dashcam frames are 1280x960 - 4:3, not 16:9. Laying them out as widescreen
 *  is what produces the stretched footage every viewer has been accused of. */
export const FRAME = { w: 1280, h: 960 }
export const ASPECT = FRAME.w / FRAME.h

/**
 * Positions for the chosen cameras, in a 0..1 coordinate space.
 *
 * 'tesla' mirrors the car's own review screen and the layout the car itself uses:
 * front on top, then right, back, left in a row beneath. It only makes sense
 * with all four; with fewer, a plain grid reads better, so the caller is
 * expected to fall back - `layoutFor` does that.
 */
export function layoutFor(name: LayoutName, cams: Camera[]): Map<Camera, Rect> {
  const out = new Map<Camera, Rect>()
  if (!cams.length) return out

  if (name === 'tesla' && cams.length === 4) {
    out.set('front', { x: 0.25, y: 0, w: 0.5, h: 0.5 })
    out.set('right_repeater', { x: 0, y: 0.5, w: 1 / 3, h: 0.5 })
    out.set('back', { x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 })
    out.set('left_repeater', { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 })
    return out
  }

  if (name === 'single' || cams.length === 1) {
    out.set(cams[0], { x: 0, y: 0, w: 1, h: 1 })
    return out
  }

  if (name === 'wide') {
    const w = 1 / cams.length
    cams.forEach((c, i) => out.set(c, { x: i * w, y: 0, w, h: 1 }))
    return out
  }

  // grid, and the fallback for 'tesla' with fewer than four cameras.
  const cols = cams.length <= 2 ? cams.length : 2
  const rows = Math.ceil(cams.length / cols)
  cams.forEach((c, i) => out.set(c, {
    x: (i % cols) / cols,
    y: Math.floor(i / cols) / rows,
    w: 1 / cols,
    h: 1 / rows,
  }))
  return out
}

/** Pixel size of the composed frame for an export. Keeps each tile at the
 *  camera's own resolution rather than upscaling a 1280x960 source. */
export function canvasSize(layout: Map<Camera, Rect>): { w: number; h: number } {
  if (!layout.size) return { w: FRAME.w, h: FRAME.h }
  const smallestW = Math.min(...[...layout.values()].map((r) => r.w))
  const smallestH = Math.min(...[...layout.values()].map((r) => r.h))
  // Even dimensions: H.264 chroma subsampling requires it, and an odd width
  // is rejected by the encoder with a message that explains nothing.
  const w = Math.round(FRAME.w / smallestW / 2) * 2
  const h = Math.round(FRAME.h / smallestH / 2) * 2
  // Cap the long edge. Four tiles at native size is 3840x1920, which encodes
  // slowly on a laptop and pleases nobody.
  const scale = Math.min(1, 2560 / Math.max(w, h))
  return { w: Math.round(w * scale / 2) * 2, h: Math.round(h * scale / 2) * 2 }
}

export interface OverlayFrame {
  telemetry: Telemetry | null
  /** Wall-clock time of this frame, from the clip name plus the offset. */
  at: Date
  place?: string
  /** True when this clip has no telemetry at all, as opposed to a gap. */
  noTelemetry: boolean
}

const GEAR_LETTER: Record<string, string> = {
  park: 'P', drive: 'D', reverse: 'R', neutral: 'N',
}

/**
 * Draw the HUD.
 *
 * One function, used by the canvas exporter and - through a hidden canvas - by
 * the player, so the recording and the preview cannot drift apart.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  frame: OverlayFrame,
  opts: OverlayOptions,
  lang: 'da' | 'en' = 'da',
) {
  const pad = Math.round(size.h * 0.025)
  const unitScale = size.h / 960

  if (opts.clock) {
    const stamp = frame.at.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    label(ctx, stamp, pad, pad, 26 * unitScale, 'left')
  }

  if (opts.place && frame.place) {
    label(ctx, frame.place, size.w - pad, pad, 26 * unitScale, 'right')
  }

  if (!opts.speed && !opts.gear) return

  const t = frame.telemetry
  const boxH = Math.round(96 * unitScale)
  const boxW = Math.round((opts.gear ? 300 : 230) * unitScale)
  const bx = Math.round((size.w - boxW) / 2)
  const by = size.h - boxH - pad

  ctx.save()
  ctx.fillStyle = 'rgba(11, 13, 14, 0.72)'
  roundRect(ctx, bx, by, boxW, boxH, 14 * unitScale)
  ctx.fill()

  if (!t) {
    // No reading is a state worth naming. A blank box looks broken; a zero
    // would be a lie.
    ctx.fillStyle = '#7d8a8f'
    ctx.font = `${Math.round(24 * unitScale)}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      frame.noTelemetry
        ? (lang === 'da' ? 'ingen telemetri' : 'no telemetry')
        : (lang === 'da' ? 'ingen data' : 'no data'),
      bx + boxW / 2, by + boxH / 2,
    )
    ctx.restore()
    return
  }

  let x = bx + Math.round(24 * unitScale)

  if (opts.gear) {
    ctx.fillStyle = t.gear === 'reverse' ? '#e8a33d' : '#f0f3f4'
    ctx.font = `600 ${Math.round(40 * unitScale)}px ui-monospace, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(GEAR_LETTER[t.gear] ?? '?', x, by + boxH / 2)
    x += Math.round(52 * unitScale)
  }

  if (opts.speed) {
    const v = speedIn(opts.unit, t.speedMps)
    ctx.fillStyle = '#f0f3f4'
    ctx.font = `600 ${Math.round(56 * unitScale)}px ui-monospace, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(v), x, by + boxH / 2 - Math.round(4 * unitScale))
    const numW = ctx.measureText(String(v)).width

    ctx.fillStyle = '#a8b3b7'
    ctx.font = `${Math.round(20 * unitScale)}px ui-monospace, monospace`
    ctx.fillText(opts.unit === 'kmh' ? 'km/t' : 'mph',
                 x + numW + Math.round(10 * unitScale), by + boxH / 2 + Math.round(10 * unitScale))
  }

  // Brake and indicators, as three small lamps. They cost almost nothing to
  // draw and answer the question a dashcam clip is usually pulled up to settle.
  const lampR = Math.round(7 * unitScale)
  const lampY = by + boxH - Math.round(18 * unitScale)
  const lampX = bx + boxW - Math.round(30 * unitScale)
  lamp(ctx, lampX - lampR * 6, lampY, lampR, t.blinkerLeft ? '#e8a33d' : '#2b3235')
  lamp(ctx, lampX - lampR * 3, lampY, lampR, t.braking ? '#e0544a' : '#2b3235')
  lamp(ctx, lampX, lampY, lampR, t.blinkerRight ? '#e8a33d' : '#2b3235')

  ctx.restore()
}

/** The camera name in its corner, matching the car's own review screen.
 *
 *  Positioned against the *contained* picture, not the tile. A 4:3 frame in a
 *  2:1 tile is letterboxed, and anchoring to the tile put every label in the
 *  black band above its own video. */
export function drawCameraLabel(
  ctx: CanvasRenderingContext2D, cam: Camera, rect: Rect,
  size: { w: number; h: number }, lang: 'da' | 'en',
) {
  const box = contain(rect, size)
  const inset = Math.round(size.h * 0.012)
  label(ctx, CAMERA_LABEL[cam][lang].toUpperCase(),
        box.x + inset, box.y + inset, Math.round(size.h * 0.022), 'left')
}

function label(
  ctx: CanvasRenderingContext2D, text: string,
  x: number, y: number, fontPx: number, align: 'left' | 'right',
) {
  ctx.save()
  ctx.font = `600 ${Math.round(fontPx)}px ui-monospace, monospace`
  ctx.textBaseline = 'top'
  const padX = Math.round(fontPx * 0.5)
  const padY = Math.round(fontPx * 0.3)
  const w = ctx.measureText(text).width + padX * 2
  const h = fontPx + padY * 2
  const bx = align === 'right' ? x - w : x
  ctx.fillStyle = 'rgba(11, 13, 14, 0.7)'
  roundRect(ctx, bx, y, w, h, Math.round(fontPx * 0.3))
  ctx.fill()
  ctx.fillStyle = '#f0f3f4'
  ctx.textAlign = 'left'
  ctx.fillText(text, bx + padX, y + padY)
  ctx.restore()
}

function lamp(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = colour
  ctx.fill()
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Fit a 4:3 frame inside a tile without stretching it. */
export function contain(rect: Rect, size: { w: number; h: number }): Rect {
  const boxW = rect.w * size.w
  const boxH = rect.h * size.h
  const scale = Math.min(boxW / FRAME.w, boxH / FRAME.h)
  const w = FRAME.w * scale
  const h = FRAME.h * scale
  return {
    x: rect.x * size.w + (boxW - w) / 2,
    y: rect.y * size.h + (boxH - h) / 2,
    w, h,
  }
}
