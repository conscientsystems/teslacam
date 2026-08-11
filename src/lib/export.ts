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
  /** Inclusive segment range, so a ten-minute event can yield ten seconds. */
  fromSegment: number
  toSegment: number
  lang: 'da' | 'en'
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

  close() {
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
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e },
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

  const segments = req.event.segments.slice(req.fromSegment, req.toSegment + 1)
  let written = 0
  const frameDur = 1e6 / CLIP_FPS

  try {
    for (let si = 0; si < segments.length; si++) {
      if (signal?.aborted) throw new Error('Afbrudt')
      const seg = segments[si]
      onProgress({
        phase: 'decoding', segment: si + 1, segments: segments.length,
        frames: written, fraction: si / segments.length,
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
      const expected = Math.max(...[...sources.values()].map((s) => s.chunks.length))

      const streams = new Map<Camera, FrameStream>()
      for (const [cam, src] of sources) streams.set(cam, new FrameStream(src))

      try {
        for (let f = 0; ; f++) {
          if (signal?.aborted) throw new Error('Afbrudt')

          // One frame from every camera, in step.
          const frames = new Map<Camera, VideoFrame>()
          for (const [cam, stream] of streams) {
            const frame = await stream.pull()
            if (frame) frames.set(cam, frame)
          }
          if (!frames.size) break

          const t = f / CLIP_FPS
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, size.w, size.h)

          for (const [cam, rect] of layout) {
            const frame = frames.get(cam)
            if (!frame) continue
            const box = contain(rect, size)
            ctx.drawImage(frame, box.x, box.y, box.w, box.h)
            if (req.overlay.labels) drawCameraLabel(ctx as any, cam, rect, size, req.lang)
          }
          for (const frame of frames.values()) frame.close()

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

          if (encoder.encodeQueueSize > 20) {
            await new Promise((r) => setTimeout(r, 0))
          }
          if (f % 30 === 0) {
            onProgress({
              phase: 'encoding', segment: si + 1, segments: segments.length,
              frames: written,
              fraction: (si + Math.min(1, f / Math.max(1, expected))) / segments.length,
            })
          }
        }
      } finally {
        for (const stream of streams.values()) stream.close()
      }
    }

    onProgress({
      phase: 'writing', segment: segments.length, segments: segments.length,
      frames: written, fraction: 0.99,
    })
    await encoder.flush()
    muxer.finalize()

    onProgress({
      phase: 'done', segment: segments.length, segments: segments.length,
      frames: written, fraction: 1,
    })
    const { buffer } = muxer.target as ArrayBufferTarget
    return new Blob([buffer], { type: 'video/mp4' })
  } finally {
    try { encoder.close() } catch { /* already closed by flush */ }
  }
}

/** A filename that says what it is without being opened. */
export function exportName(req: ExportRequest): string {
  const seg = req.event.segments[req.fromSegment]
  const stamp = seg ? seg.key : 'teslacam'
  const cams = req.cameras.length === 4 ? 'alle' : req.cameras.length
  return `teslacam_${stamp}_${cams}kam.mp4`
}
