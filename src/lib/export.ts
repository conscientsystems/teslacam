/**
 * Writing the composed view out as a video file, entirely in the browser.
 *
 * demux (mp4box) -> decode (WebCodecs) -> draw (canvas) -> encode -> mux (mp4-muxer)
 *
 * Not MediaRecorder over a playing video: that runs at wall-clock speed, so a
 * ten-minute sentry event takes ten minutes and produces WebM. This runs as
 * fast as the machine can decode and writes an MP4 that plays anywhere - which
 * matters, because the reason to export a dashcam clip is to send it to someone.
 *
 * Nothing leaves the browser. The server hosts the page and never sees a frame.
 *
 * **The cameras are decoded in lockstep, a few frames at a time.** The obvious
 * shape - decode each camera fully, then compose - deadlocks: a decoded
 * 1280x960 frame is about 1.8 MB and a minute is 2200 of them per camera, so
 * holding four cameras' worth exhausts the frame pool. Chrome then applies
 * backpressure and `flush()` simply never resolves. No error, no timeout, an
 * export stuck at 0% forever. Frames are closed as soon as they are drawn and
 * no camera runs more than a handful ahead.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { DataStream, Endianness, MP4BoxBuffer, createFile, type Movie, type Sample } from 'mp4box'

import {
  canvasSize, contain, drawCameraLabel, drawOverlay, layoutFor,
  type LayoutName, type OverlayOptions,
} from './compose'
import { CAMERAS, type Camera, type TeslaEvent } from './library'
import { CLIP_FPS, buildIndex, extractTelemetry, type Telemetry } from './sei'

export interface ExportRequest {
  event: TeslaEvent
  cameras: Camera[]
  layout: LayoutName
  overlay: OverlayOptions
  /** In and out points in whole-event seconds - the timeline's two handles.
   *  Cutting used to be by whole one-minute files, which meant exporting a
   *  four-second near-miss produced a minute of driving around it. */
  fromSec: number
  toSec: number
  lang: 'da' | 'en'
}

/** One segment's share of the selection, in seconds inside that segment. */
export interface TrimPart {
  index: number
  fromOffset: number
  toOffset: number
}

/**
 * Which part of which file the two handles select.
 *
 * Kept separate from the export itself because it is the part that is easy to
 * get wrong and easy to test: an in-point inside segment 3, an out-point in
 * the middle of segment 5, and the segments between them taken whole.
 */
export function planTrim(event: TeslaEvent, fromSec: number, toSec: number): TrimPart[] {
  const from = Math.max(0, Math.min(fromSec, toSec))
  const to = Math.max(fromSec, toSec)
  const parts: TrimPart[] = []
  let start = 0
  for (let i = 0; i < event.segments.length; i++) {
    const dur = event.segments[i].durationSec ?? 60
    const end = start + dur
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    // A handle landing exactly on a boundary must not add an empty part, or
    // the exporter opens a 40 MB file to write nothing from it.
    if (b - a > 0.001) parts.push({ index: i, fromOffset: a - start, toOffset: b - start })
    start = end
  }
  return parts
}

export interface ExportProgress {
  phase: 'preparing' | 'decoding' | 'encoding' | 'writing' | 'done'
  segment: number
  segments: number
  frames: number
  /** 0..1 across the whole job. */
  fraction: number
}

export function canExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'
}

/** How far ahead a single camera may decode. Small enough that four cameras
 *  together stay well inside the frame pool, large enough to keep the decoder
 *  busy between draws. */
const LOOKAHEAD = 6

/** How many composed frames may wait in the encoder. Each one is a full
 *  canvas snapshot (2560x1280 RGBA is 13 MB), and they are held until encoded.
 *  The encoder is the slowest stage, so without this bound the queue grows
 *  with the length of the export: a ten-minute export piled up gigabytes of
 *  frames, Edge's GPU process died at 16 GB, and the next file read failed for
 *  want of memory with a NotReadableError that says nothing of the kind. */
const ENCODE_AHEAD = 8

/** Resolves once the encoder has room again. `dequeue` fires every time a
 *  frame leaves the queue; the timer is a safety net, not the mechanism. */
function encoderRoom(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      encoder.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, 50)
    encoder.addEventListener('dequeue', done)
  })
}

/** Demuxed video: the chunks to feed a decoder, plus what is needed to make one. */
interface Demuxed {
  chunks: EncodedVideoChunk[]
  codec: string
  width: number
  height: number
  description: Uint8Array
  telemetry: Telemetry[]
}

/**
 * Read one MP4 into encoded chunks. No decoding yet.
 *
 * `setExtractionOptions` and `start()` run **inside** `onReady`, before
 * `appendBuffer` returns. mp4box releases sample data as it parses, so doing it
 * a microtask later - by awaiting a promise that onReady resolves - leaves the
 * file parsed, the track described, `nb_samples` correct, and not one sample
 * delivered. It looks exactly like a file with no frames in it.
 */
async function demux(file: File): Promise<Demuxed> {
  const buffer = await file.arrayBuffer()
  const telemetry = extractTelemetry(buffer).samples

  const mp4 = createFile()
  const samples: Sample[] = []
  let failure: string | null = null
  let track: any = null
  let description: Uint8Array | null = null

  mp4.onError = (e: string) => { failure = e }
  mp4.onSamples = (_id: number, _user: unknown, s: Sample[]) => { samples.push(...s) }
  mp4.onReady = (info: Movie) => {
    const t = info.videoTracks[0]
    if (!t) { failure = 'ingen videostrøm'; return }
    track = t

    // avcC, which VideoDecoder needs as its `description`. Without it every
    // sample is rejected for missing parameter sets, which reads like a corrupt
    // file rather than a missing header.
    const trak = mp4.getTrackById(t.id) as any
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC ?? entry.hvcC
      if (!box) continue
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
      box.write(stream)
      description = new Uint8Array(stream.buffer.slice(8))   // drop the box header
      break
    }

    mp4.setExtractionOptions(t.id, undefined, { nbSamples: t.nb_samples })
    mp4.start()
  }

  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0))
  mp4.flush()

  if (failure) throw new Error(failure)
  if (!track || !description) throw new Error('klippet kunne ikke læses')
  if (!samples.length) throw new Error('ingen billeder i klippet')

  const chunks = samples
    .filter((s) => s.data)
    .map((s) => new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: (s.cts * 1e6) / s.timescale,
      duration: (s.duration * 1e6) / s.timescale,
      data: s.data!,
    }))

  return {
    chunks,
    codec: track.codec,
    width: track.video.width,
    height: track.video.height,
    description,
    telemetry,
  }
}

/**
 * A decoder you can pull frames from one at a time.
 *
 * Feeds itself only while fewer than LOOKAHEAD frames are outstanding, which is
 * what keeps the frame pool from filling and the decoder from stalling.
 */
class FrameStream {
  private ready: VideoFrame[] = []
  private waiting: ((f: VideoFrame | null) => void) | null = null
  private next = 0
  private flushing = false
  private ended = false
  private failed: Error | null = null
  private readonly decoder: VideoDecoder

  constructor(private readonly src: Demuxed) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const resolve = this.waiting
        if (resolve) {
          this.waiting = null
          resolve(frame)
        } else {
          this.ready.push(frame)
        }
        this.pump()
      },
      error: (e) => {
        this.failed = e instanceof Error ? e : new Error(String(e))
        const resolve = this.waiting
        if (resolve) { this.waiting = null; resolve(null) }
      },
    })
    this.decoder.configure({
      codec: src.codec,
      codedWidth: src.width,
      codedHeight: src.height,
      description: src.description,
      optimizeForLatency: false,
    })
    this.pump()
  }

  private pump() {
    if (this.decoder.state !== 'configured') return
    while (this.next < this.src.chunks.length
           && this.ready.length + this.decoder.decodeQueueSize < LOOKAHEAD) {
      this.decoder.decode(this.src.chunks[this.next++])
    }
    if (this.next >= this.src.chunks.length && !this.flushing) {
      this.flushing = true
      // Not awaited: the remaining frames arrive through `output` like the
      // rest, and awaiting here would deadlock against our own backpressure.
      void this.decoder.flush()
        .catch(() => {})
        .finally(() => {
          this.ended = true
          const resolve = this.waiting
          if (resolve && !this.ready.length) { this.waiting = null; resolve(null) }
        })
    }
  }

  /** The next frame, or null when the clip is finished. The caller owns it and
   *  must close it. */
  async pull(): Promise<VideoFrame | null> {
    if (this.failed) throw this.failed
    const queued = this.ready.shift()
    if (queued) { this.pump(); return queued }
    if (this.ended) return null
    return new Promise<VideoFrame | null>((resolve) => {
      this.waiting = resolve
      this.pump()
      if (this.ended) { this.waiting = null; resolve(null) }
    })
  }

  private current: VideoFrame | null = null
  private upcoming: VideoFrame | null = null
  private drained = false

  /**
   * The frame on screen `us` microseconds into the clip, or null once the clip
   * has run out. The stream keeps ownership: draw it, do not close it.
   *
   * Frames are matched by timestamp, not taken one per output frame, because
   * the cameras do not share a frame rate. The back camera records 30 fps
   * against 36 for the others, so pulling one frame each per output frame ran
   * it 20% fast and emptied it 51 seconds into every minute - the last ten
   * seconds of each file exported with a black hole where the back camera was.
   */
  async frameAt(us: number): Promise<VideoFrame | null> {
    for (;;) {
      if (!this.upcoming && !this.drained) {
        this.upcoming = await this.pull()
        if (!this.upcoming) this.drained = true
      }
      if (this.upcoming && (!this.current || this.upcoming.timestamp <= us)) {
        this.current?.close()
        this.current = this.upcoming
        this.upcoming = null
        continue
      }
      break
    }
    const cur = this.current
    if (!cur) return null
    // Past the last frame's own duration the clip is over, even if that frame
    // is still held - showing it frozen would pass for live footage.
    if (this.drained && us >= cur.timestamp + (cur.duration ?? 1e6 / CLIP_FPS)) return null
    return cur
  }

  close() {
    this.current?.close()
    this.upcoming?.close()
    this.current = this.upcoming = null
    for (const f of this.ready) f.close()
    this.ready = []
    try { this.decoder.close() } catch { /* already closed */ }
  }
}

/** Compose and encode. Returns an MP4 blob. */
export async function exportVideo(
  req: ExportRequest,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!canExport()) throw new Error('WebCodecs er ikke tilgængelig i denne browser')

  const cams = CAMERAS.filter((c) => req.cameras.includes(c))
  if (!cams.length) throw new Error('Vælg mindst ét kamera')

  const layout = layoutFor(req.layout, cams)
  const size = canvasSize(layout)
  const canvas = new OffscreenCanvas(size.w, size.h)
  const ctx = canvas.getContext('2d')!

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: size.w, height: size.h, frameRate: CLIP_FPS },
    fastStart: 'in-memory',
  })
  // Thrown from inside the callback the error went nowhere, and the export
  // waited forever for an encoder that was already closed.
  let encodeError: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e instanceof Error ? e : new Error(String(e)) },
  })
  encoder.configure({
    codec: 'avc1.4d0034',            // Main profile, level 5.2: 2560x1440 fits
    width: size.w,
    height: size.h,
    // Tesla's own clips are about 5 Mbit each, so a composite needs room or
    // the export looks worse than the source it came from.
    bitrate: 4_000_000 + cams.length * 2_000_000,
    framerate: CLIP_FPS,
  })

  const parts = planTrim(req.event, req.fromSec, req.toSec)
  if (!parts.length) throw new Error('Markeringen er tom')
  const wanted = parts.reduce((n, p) => n + (p.toOffset - p.fromOffset), 0)
  let written = 0
  let done = 0                      // seconds of the selection already written
  const frameDur = 1e6 / CLIP_FPS

  try {
    for (let si = 0; si < parts.length; si++) {
      if (signal?.aborted) throw new Error('Afbrudt')
      const part = parts[si]
      const seg = req.event.segments[part.index]
      onProgress({
        phase: 'decoding', segment: si + 1, segments: parts.length,
        frames: written, fraction: done / wanted,
      })

      const sources = new Map<Camera, Demuxed>()
      for (const cam of cams) {
        const file = seg.files[cam]
        if (file) sources.set(cam, await demux(file))
      }
      if (!sources.size) continue

      // The HUD reads from whichever camera carries the most telemetry: the
      // back camera of a segment can have fewer samples than the front, or none.
      const richest = [...sources.values()].sort(
        (a, b) => b.telemetry.length - a.telemetry.length)[0]
      const hud = buildIndex(richest.telemetry)
      const noTelemetry = richest.telemetry.length === 0

      const streams = new Map<Camera, FrameStream>()
      for (const [cam, src] of sources) streams.set(cam, new FrameStream(src))

      try {
        for (let f = 0; ; f++) {
          if (signal?.aborted) throw new Error('Afbrudt')

          const t = f / CLIP_FPS
          // Past the out-point: stop this file rather than decode the rest of
          // it. The frames before the in-point cannot be skipped the same way -
          // H.264 frames depend on the ones before them, so they are decoded
          // and thrown away.
          if (t >= part.toOffset) break

          // Whatever each camera shows at this instant. The streams own the
          // frames and close them as they move past.
          const frames = new Map<Camera, VideoFrame>()
          for (const [cam, stream] of streams) {
            const frame = await stream.frameAt(t * 1e6)
            if (frame) frames.set(cam, frame)
          }
          if (!frames.size) break

          if (t < part.fromOffset) continue
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, size.w, size.h)

          for (const [cam, rect] of layout) {
            const frame = frames.get(cam)
            if (!frame) continue
            const box = contain(rect, size)
            ctx.drawImage(frame, box.x, box.y, box.w, box.h)
            if (req.overlay.labels) drawCameraLabel(ctx as any, cam, rect, size, req.lang)
          }

          drawOverlay(ctx as any, size, {
            telemetry: hud ? hud(t) : null,
            at: new Date(seg.startedAt.getTime() + t * 1000),
            place: req.event.meta?.city,
            noTelemetry,
          }, req.overlay, req.lang)

          const out = new VideoFrame(canvas, {
            timestamp: Math.round(written * frameDur),
            duration: Math.round(frameDur),
          })
          // A keyframe every two seconds keeps the file seekable without
          // bloating it; players scrub badly with one keyframe per minute.
          encoder.encode(out, { keyFrame: written % (CLIP_FPS * 2) === 0 })
          out.close()
          written++

          while (encoder.encodeQueueSize > ENCODE_AHEAD && !encodeError) {
            await encoderRoom(encoder)
          }
          if (encodeError) throw encodeError
          if (f % 30 === 0) {
            onProgress({
              phase: 'encoding', segment: si + 1, segments: parts.length,
              frames: written,
              fraction: Math.min(0.98, (done + (t - part.fromOffset)) / wanted),
            })
          }
        }
      } finally {
        for (const stream of streams.values()) stream.close()
      }
      done += part.toOffset - part.fromOffset
    }

    onProgress({
      phase: 'writing', segment: parts.length, segments: parts.length,
      frames: written, fraction: 0.99,
    })
    await encoder.flush()
    if (encodeError) throw encodeError
    muxer.finalize()

    onProgress({
      phase: 'done', segment: parts.length, segments: parts.length,
      frames: written, fraction: 1,
    })
    const { buffer } = muxer.target as ArrayBufferTarget
    return new Blob([buffer], { type: 'video/mp4' })
  } finally {
    try { encoder.close() } catch { /* already closed by flush */ }
  }
}

/** A filename that says what it is without being opened: the clock time the
 *  selection starts at, and how long it runs. */
export function exportName(req: ExportRequest): string {
  const parts = planTrim(req.event, req.fromSec, req.toSec)
  const first = parts[0]
  const seg = first ? req.event.segments[first.index] : undefined
  const at = seg ? new Date(seg.startedAt.getTime() + first.fromOffset * 1000) : req.event.startedAt
  const stamp = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('-') + '_' + [
    String(at.getHours()).padStart(2, '0'),
    String(at.getMinutes()).padStart(2, '0'),
    String(at.getSeconds()).padStart(2, '0'),
  ].join('-')
  const secs = Math.max(1, Math.round(Math.abs(req.toSec - req.fromSec)))
  const cams = req.cameras.length === 4 ? 'alle' : req.cameras.length
  return `teslacam_${stamp}_${secs}s_${cams}kam.mp4`
}
