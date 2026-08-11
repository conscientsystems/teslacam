/**
 * Reading Tesla's telemetry out of a dashcam clip.
 *
 * There is no sidecar file and no metadata track: speed, steering, gear, GPS
 * and the autopilot state are carried in SEI NAL units *inside* the H.264
 * bitstream. That is why ffprobe reports a single video stream and nothing
 * else, and why a clip either has telemetry or does not - firmware 2025.44.25
 * and HW3 or newer write it, everything older writes nothing at all.
 *
 * Measured on real clips before any of this was written: a one-minute 2026
 * clip carries 327 SEI messages; a 2024 clip carries zero.
 *
 * The field numbers below are Tesla's own `dashcam.proto`, not guesses.
 */

export type Gear = 'park' | 'drive' | 'reverse' | 'neutral'
export type Autopilot = 'none' | 'self_driving' | 'autosteer' | 'tacc'

const GEARS: Gear[] = ['park', 'drive', 'reverse', 'neutral']
const AUTOPILOT: Autopilot[] = ['none', 'self_driving', 'autosteer', 'tacc']

export interface Telemetry {
  version: number
  gear: Gear
  frame: number
  /** Metres per second, as recorded. Convert at the point of display. */
  speedMps: number
  acceleratorPct: number
  steeringDeg: number
  blinkerLeft: boolean
  blinkerRight: boolean
  braking: boolean
  autopilot: Autopilot
  lat: number
  lon: number
  headingDeg: number
  accelX: number
  accelY: number
  accelZ: number
}

/** A tiny protobuf reader. Sixteen scalar fields, no nesting, no repeats -
 *  bundling a general protobuf library for that would cost more than it saves. */
class Reader {
  private p = 0
  constructor(private readonly b: Uint8Array) {}
  get done() { return this.p >= this.b.length }

  varint(): number {
    let out = 0
    let shift = 0
    while (this.p < this.b.length) {
      const byte = this.b[this.p++]
      out += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    return out
  }

  fixed32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true)
    this.p += 4
    return v
  }

  fixed64(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8).getFloat64(0, true)
    this.p += 8
    return v
  }

  /** Skip a field we do not model, by wire type. Without this a future
   *  firmware adding a field would desynchronise every field after it. */
  skip(wire: number) {
    if (wire === 0) this.varint()
    else if (wire === 5) this.p += 4
    else if (wire === 1) this.p += 8
    else if (wire === 2) this.p += this.varint()
    else this.p = this.b.length
  }
}

function decodeMessage(body: Uint8Array): Telemetry | null {
  const r = new Reader(body)
  const t: Telemetry = {
    version: 0, gear: 'park', frame: 0, speedMps: 0, acceleratorPct: 0,
    steeringDeg: 0, blinkerLeft: false, blinkerRight: false, braking: false,
    autopilot: 'none', lat: 0, lon: 0, headingDeg: 0,
    accelX: 0, accelY: 0, accelZ: 0,
  }
  let sawSomething = false

  while (!r.done) {
    const key = r.varint()
    const field = key >>> 3
    const wire = key & 7
    sawSomething = true
    switch (field) {
      case 1: t.version = r.varint(); break
      case 2: t.gear = GEARS[r.varint()] ?? 'park'; break
      case 3: t.frame = r.varint(); break
      case 4: t.speedMps = r.fixed32(); break
      case 5: t.acceleratorPct = r.fixed32(); break
      case 6: t.steeringDeg = r.fixed32(); break
      case 7: t.blinkerLeft = r.varint() !== 0; break
      case 8: t.blinkerRight = r.varint() !== 0; break
      case 9: t.braking = r.varint() !== 0; break
      case 10: t.autopilot = AUTOPILOT[r.varint()] ?? 'none'; break
      case 11: t.lat = r.fixed64(); break
      case 12: t.lon = r.fixed64(); break
      case 13: t.headingDeg = r.fixed64(); break
      case 14: t.accelX = r.fixed64(); break
      case 15: t.accelY = r.fixed64(); break
      case 16: t.accelZ = r.fixed64(); break
      default: r.skip(wire)
    }
  }
  return sawSomething ? t : null
}

/** Undo H.264 emulation prevention: 00 00 03 in the byte stream means 00 00.
 *  Skipping this corrupts any field that happens to span such a sequence, and
 *  it does happen - a latitude double is eight bytes of arbitrary values. */
function stripEmulation(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  let n = 0
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0
        && i + 1 < data.length && data[i + 1] <= 3) {
      continue
    }
    out[n++] = data[i]
  }
  return out.subarray(0, n)
}

/** Find the mdat payload without parsing the whole file.
 *  Returns the bytes and the offset, or null if this is not an MP4. */
function findBox(buf: ArrayBuffer, want: string): { start: number; end: number } | null {
  const view = new DataView(buf)
  let off = 0
  while (off + 8 <= buf.byteLength) {
    let size = view.getUint32(off)
    const type = String.fromCharCode(
      view.getUint8(off + 4), view.getUint8(off + 5),
      view.getUint8(off + 6), view.getUint8(off + 7),
    )
    let header = 8
    if (size === 1) {
      // 64-bit size. Dashcam clips are ~40 MB so this never fires in practice,
      // but a silent misparse here would look like "no telemetry".
      size = Number(view.getBigUint64(off + 8))
      header = 16
    }
    if (size <= 0) return null
    if (type === want) return { start: off + header, end: off + size }
    off += size
  }
  return null
}

export interface SeiResult {
  /** One entry per frame that carried telemetry, in bitstream order. */
  samples: Telemetry[]
  /** True when the file is readable but simply has no telemetry - an older
   *  clip. Distinguishing this from a parse failure is the whole point: one is
   *  normal and one is a bug. */
  empty: boolean
}

/**
 * Extract every telemetry sample from an MP4.
 *
 * Assumes AVCC framing (4-byte length prefixes), which is what MP4 uses.
 * Annex-B start codes are a raw-stream thing and do not appear here.
 */
export function extractTelemetry(buf: ArrayBuffer): SeiResult {
  const mdat = findBox(buf, 'mdat')
  if (!mdat) return { samples: [], empty: true }

  const bytes = new Uint8Array(buf, mdat.start, mdat.end - mdat.start)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples: Telemetry[] = []
  let cursor = 0

  while (cursor + 4 <= bytes.length) {
    const size = view.getUint32(cursor)
    cursor += 4
    if (size < 2 || cursor + size > bytes.length) break

    // NAL type 6 is SEI; payload type 5 is user_data_unregistered.
    if ((bytes[cursor] & 0x1f) === 6 && bytes[cursor + 1] === 5) {
      const nal = bytes.subarray(cursor, cursor + size)
      // Tesla writes 'BBB' then 'i' where the payload UUID would be, and the
      // protobuf follows. Walk the Bs rather than assuming how many there are.
      let i = 3
      while (i < nal.length && nal[i] === 0x42) i++
      if (i > 3 && i + 1 < nal.length && nal[i] === 0x69) {
        const body = stripEmulation(nal.subarray(i + 1, nal.length - 1))
        const t = decodeMessage(body)
        if (t) samples.push(t)
      }
    }
    cursor += size
  }

  return { samples, empty: samples.length === 0 }
}

/** Frames per second in a Tesla dashcam clip, and therefore the rate at which
 *  `frame_seq_no` advances. Confirmed against a full clip: 2205 frames of span
 *  over a 61.22-second file is 36.0 fps. */
export const CLIP_FPS = 36

/**
 * The sample at a playback position, or null when there is none.
 *
 * Indexed by `frame_seq_no`, not by position in the array, because telemetry
 * is not continuous. Measured across one drive:
 *
 *   - a clip with 2206 samples stepping by exactly 1  (full coverage)
 *   - a clip with 1470 samples covering the first 41 s and nothing after
 *   - a clip with 424 samples split by a single 1064-frame gap - half a minute
 *     in the middle with no data at all
 *   - the back camera of the same minute as the front: 1830 samples, not 2206
 *
 * Treating the array as evenly spaced would put the HUD up to thirty seconds
 * out on that third clip, and would show a speed during the gap that the car
 * was not doing. Null during a gap is the honest answer.
 */
export function buildIndex(samples: Telemetry[], fps: number = CLIP_FPS) {
  if (!samples.length || fps <= 0) return null
  const first = samples[0].frame
  // Half a second either side. Wide enough to survive rounding and a dropped
  // frame, narrow enough that a real gap reads as a gap.
  const tolerance = Math.round(fps / 2)

  return (t: number): Telemetry | null => {
    if (t < 0) return null
    const want = first + Math.round(t * fps)

    let lo = 0
    let hi = samples.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (samples[mid].frame < want) lo = mid + 1
      else hi = mid
    }
    // lo is the first sample at or after `want`; the one before it may be closer.
    const after = samples[lo]
    const before = samples[Math.max(0, lo - 1)]
    const best = Math.abs(after.frame - want) <= Math.abs(before.frame - want) ? after : before
    return Math.abs(best.frame - want) <= tolerance ? best : null
  }
}

/** The last playback second the telemetry reaches, so the UI can say "data
 *  stops after 41 s" rather than going quiet with no explanation. */
export function telemetrySeconds(samples: Telemetry[], fps: number = CLIP_FPS): number {
  if (!samples.length) return 0
  return (samples[samples.length - 1].frame - samples[0].frame + 1) / fps
}

/**
 * Speed for display, in the requested unit.
 *
 * The magnitude, because that is what a speedometer shows. Speed is signed -
 * reversing reads negative, confirmed against a sample of -2.39 m/s with the
 * gear in reverse - and a HUD reading "-9 km/h" would be a puzzle rather than
 * information. The gear indicator next to it says which way the car is going.
 */
export function speedIn(unit: 'kmh' | 'mph', mps: number): number {
  const v = Math.abs(mps)
  return Math.round(unit === 'kmh' ? v * 3.6 : v * 2.236936)
}
