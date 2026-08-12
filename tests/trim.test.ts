/**
 * The cut itself: which part of which file the two handles select.
 *
 * This is the arithmetic between a timeline the user drags and a stack of
 * one-minute files, and getting it wrong is expensive to notice - the export
 * runs for a minute before producing footage that starts in the wrong place.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planTrim, type ExportRequest } from '../src/lib/export.ts'
import { exportName } from '../src/lib/export.ts'
import type { TeslaEvent } from '../src/lib/library.ts'

/** Four segments: a minute each except the last, which is how events end. */
function event(durations = [60, 60, 60, 12]): TeslaEvent {
  const start = new Date('2026-08-11T12:36:58')
  let acc = 0
  const segments = durations.map((d, i) => {
    const startedAt = new Date(start.getTime() + acc * 1000)
    acc += d
    return { key: `seg${i}`, startedAt, files: {}, durationSec: d }
  })
  return {
    id: 'e', source: 'saved', name: 'test', startedAt: start, segments,
  } as unknown as TeslaEvent
}

test('the whole event is every segment, whole', () => {
  const e = event()
  const parts = planTrim(e, 0, 192)
  assert.equal(parts.length, 4)
  assert.deepEqual(parts[0], { index: 0, fromOffset: 0, toOffset: 60 })
  assert.deepEqual(parts[3], { index: 3, fromOffset: 0, toOffset: 12 })
})

test('a selection inside one file touches only that file', () => {
  // The whole point: a four-second near-miss must not export the minute
  // around it.
  const parts = planTrim(event(), 71, 75)
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0], { index: 1, fromOffset: 11, toOffset: 15 })
})

test('a selection across a boundary takes the tail and then the head', () => {
  const parts = planTrim(event(), 50, 70)
  assert.deepEqual(parts, [
    { index: 0, fromOffset: 50, toOffset: 60 },
    { index: 1, fromOffset: 0, toOffset: 10 },
  ])
})

test('the segments in the middle are taken whole', () => {
  const parts = planTrim(event(), 30, 150)
  assert.deepEqual(parts.map((p) => p.index), [0, 1, 2])
  assert.deepEqual(parts[1], { index: 1, fromOffset: 0, toOffset: 60 })
})

test('a handle exactly on a boundary does not open the next file', () => {
  // An empty part would make the exporter read a 40 MB file to write nothing
  // from it, and the progress bar would count a step that produces no frames.
  const parts = planTrim(event(), 0, 60)
  assert.deepEqual(parts, [{ index: 0, fromOffset: 0, toOffset: 60 }])
})

test('handles dragged past each other still describe a range', () => {
  assert.deepEqual(planTrim(event(), 75, 71), planTrim(event(), 71, 75))
})

test('the last segment is as short as it really is', () => {
  // Assuming a minute per segment put the out-point 48 seconds past the end
  // of the footage, and the exported file was shorter than the selection said.
  const parts = planTrim(event(), 180, 192)
  assert.deepEqual(parts, [{ index: 3, fromOffset: 0, toOffset: 12 }])
})

test('a selection beyond the footage is clamped, not extrapolated', () => {
  const parts = planTrim(event(), 185, 400)
  assert.deepEqual(parts, [{ index: 3, fromOffset: 5, toOffset: 12 }])
})

test('the filename says when the cut starts and how long it is', () => {
  const req = {
    event: event(), cameras: ['front', 'back'], layout: 'grid',
    overlay: {} as any, fromSec: 71, toSec: 75, lang: 'da',
  } as unknown as ExportRequest
  // 12:36:58 + one minute + eleven seconds.
  assert.equal(exportName(req), 'teslacam_2026-08-11_12-38-09_4s_2kam.mp4')
})
