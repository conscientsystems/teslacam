/**
 * The telemetry decoder, run against real dashcam clips.
 *
 * A synthetic SEI packet would prove only that the decoder agrees with the
 * decoder. These assertions are about physics and geography: a car in Denmark
 * at a plausible speed, with a frame counter that goes up by one.
 *
 * Point TESLACAM_DIR at a dashcam folder. Without one the suite says so and
 * skips rather than passing vacuously.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { CLIP_FPS, buildIndex, extractTelemetry, speedIn, telemetrySeconds } from '../src/lib/sei.ts'

const ROOT = process.env.TESLACAM_DIR ?? 'D:/TeslaCam'
const RECENT = path.join(ROOT, 'RecentClips')

function read(p: string): ArrayBuffer {
  const b = fs.readFileSync(p)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function frontClips(): string[] {
  if (!fs.existsSync(RECENT)) return []
  return fs.readdirSync(RECENT).filter((f) => f.endsWith('-front.mp4')).sort()
    .map((f) => path.join(RECENT, f))
}

/** Any clip from before the firmware that writes telemetry. Both event folders
 *  are searched, and any camera will do: a 2024 saved event often has only two
 *  of them, and looking solely for a front camera in SentryClips quietly
 *  skipped the test on a folder that did contain an old clip. */
function oldClip(): string | null {
  for (const source of ['SentryClips', 'SavedClips']) {
    const dir = path.join(ROOT, source)
    if (!fs.existsSync(dir)) continue
    for (const folder of fs.readdirSync(dir).sort()) {
      if (!/^20(2[0-4])/.test(folder)) continue
      const full = path.join(dir, folder)
      if (!fs.statSync(full).isDirectory()) continue
      const f = fs.readdirSync(full).find((x) => x.endsWith('.mp4'))
      if (f) return path.join(full, f)
    }
  }
  return null
}

test('a recorded drive carries telemetry, and it describes a real one', (t) => {
  const clips = frontClips()
  if (!clips.length) return t.skip(`no clips under ${RECENT}`)

  const decoded = clips.map((c) => ({ c, r: extractTelemetry(read(c)) }))
  const withData = decoded.filter((d) => d.r.samples.length > 0)

  // Not "every clip": telemetry stops when the car does, and the last segment
  // of a drive legitimately has none. Asserting on all of them would have made
  // a parked car look like a parser bug.
  assert.ok(withData.length > 0, 'at least one clip in a drive must have telemetry')

  for (const { c, r } of withData) {
    const first = r.samples[0]
    assert.equal(first.version, 1, `${path.basename(c)} version`)
    assert.ok(first.lat > 54 && first.lat < 58, `latitude ${first.lat} is not Denmark`)
    assert.ok(first.lon > 8 && first.lon < 13, `longitude ${first.lon} is not Denmark`)

    for (const s of r.samples) {
      // Up to 80 m/s is 288 km/h. The lower bound is negative on purpose:
      // speed is signed, and reversing reads negative. Verified rather than
      // assumed - the most negative sample in this folder is -2.39 m/s with
      // gear "reverse" and the accelerator at 12%, which is a car backing up.
      assert.ok(s.speedMps > -20 && s.speedMps < 80, `implausible speed ${s.speedMps}`)
      if (s.speedMps < -0.5) assert.equal(s.gear, 'reverse', 'negative speed means reverse')
      assert.ok(Math.abs(s.steeringDeg) <= 720, `implausible steering ${s.steeringDeg}`)
      assert.ok(['park', 'drive', 'reverse', 'neutral'].includes(s.gear))
      assert.ok(['none', 'self_driving', 'autosteer', 'tacc'].includes(s.autopilot))
    }

    // The frame counter is the strongest evidence the varint reader is right:
    // it only ever goes forward. It does NOT always step by one - telemetry
    // pauses when the car is nearly still, and one clip here has a single
    // 1064-frame gap - so monotonic is the assertion, not contiguous.
    const steps = r.samples.slice(1).map((s, i) => s.frame - r.samples[i].frame)
    assert.ok(steps.every((d) => d >= 1), `${path.basename(c)}: frame_seq_no must go forward`)
    assert.ok(r.samples[0].frame > 0, 'a real counter, not zero')
    assert.ok(telemetrySeconds(r.samples) <= 70, 'coverage cannot exceed the clip')
  }
})

test('a gap in the middle of a clip reads as a gap, not as stale data', (t) => {
  const clips = frontClips()
  const gapped = clips
    .map((c) => extractTelemetry(read(c)).samples)
    .find((s) => s.length > 1
      && s.slice(1).some((x, i) => x.frame - s[i].frame > CLIP_FPS))
  if (!gapped) return t.skip('no clip with a telemetry gap in this folder')

  const at = buildIndex(gapped)!
  const i = gapped.findIndex((x, k) => k > 0 && x.frame - gapped[k - 1].frame > CLIP_FPS)
  const before = gapped[i - 1]
  const after = gapped[i]
  const first = gapped[0].frame

  // The moment before the gap and the moment after it both resolve.
  assert.ok(at((before.frame - first) / CLIP_FPS), 'the last sample before the gap')
  assert.ok(at((after.frame - first) / CLIP_FPS), 'the first sample after it')

  // The middle of the gap must not. Holding `before` on screen for half a
  // minute would show a speed the car was not doing.
  const middle = ((before.frame + after.frame) / 2 - first) / CLIP_FPS
  assert.equal(at(middle), null, 'nothing during the gap')
})

test('a 2024 clip has no telemetry, and that is not an error', (t) => {
  const clip = oldClip()
  if (!clip) return t.skip('no 2024 clip to check')
  const { samples, empty } = extractTelemetry(read(clip))
  assert.equal(samples.length, 0)
  assert.equal(empty, true)
})

test('a file that is not an MP4 is reported empty rather than throwing', () => {
  const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8])
  const { samples, empty } = extractTelemetry(junk.buffer as ArrayBuffer)
  assert.equal(samples.length, 0)
  assert.equal(empty, true)
})

test('the index maps a playback position to a sample, and stops when data does', (t) => {
  const clips = frontClips()
  const full = clips.map((c) => extractTelemetry(read(c)).samples)
    .find((s) => s.length > CLIP_FPS * 50)
  if (!full) return t.skip('no fully-covered clip')

  const at = buildIndex(full)
  assert.ok(at)
  assert.equal(at!(-1), null, 'nothing before the clip starts')
  assert.equal(at!(0), full[0], 'the first sample at zero')
  assert.equal(at!(1), full[CLIP_FPS], 'one second in is one second of frames in')
  assert.equal(at!(10), full[CLIP_FPS * 10], 'and ten seconds in')

  // A clip whose telemetry stopped early must go quiet rather than freeze on
  // the last reading - showing 78 km/h for a parked car is worse than nothing.
  const short = full.slice(0, CLIP_FPS * 5)
  const atShort = buildIndex(short)!
  assert.ok(atShort(4.9), 'inside the covered part')
  assert.ok(atShort(5.2), 'half a second of grace for rounding at the boundary')
  assert.equal(atShort(30), null, 'well past the data: nothing')
})

test('an empty sample list produces no index', () => {
  assert.equal(buildIndex([]), null)
  assert.equal(telemetrySeconds([]), 0)
})

test('a stationary car reads zero, not minus zero', () => {
  assert.equal(speedIn('kmh', -0.0223), 0)
  // Reversing at 2.39 m/s is 9 km/h backwards; the speedometer shows 9.
  assert.equal(speedIn('kmh', -2.3917), 9)
  assert.equal(speedIn('mph', -0.0223), 0)
  // 21.7 m/s is the speed in Tor's first recorded clip.
  assert.equal(speedIn('kmh', 21.7038), 78)
  assert.equal(speedIn('mph', 21.7038), 49)
})
