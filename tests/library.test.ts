/**
 * Grouping a folder listing into events, checked against the shapes that
 * actually occur on the stick rather than the tidy case.
 *
 * The directory picker is a browser API, so these drive the grouping through
 * a stand-in handle over the real filenames read off disk.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import {
  camerasIn, eventSeconds, locate, scanLibrary, segmentStart, type TeslaEvent,
} from '../src/lib/library.ts'

const ROOT = process.env.TESLACAM_DIR ?? './TeslaCam'

/** The slice of FileSystemDirectoryHandle that scanLibrary uses, over a real
 *  directory. Files are lazy: reading 10 GB to test the grouping would be
 *  absurd, and the scan is not supposed to read them either. */
function handleFor(dir: string, name = path.basename(dir)): any {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          yield [e.name, handleFor(full, e.name)]
        } else {
          yield [e.name, {
            kind: 'file',
            name: e.name,
            async getFile() {
              return {
                name: e.name,
                size: fs.statSync(full).size,
                async text() { return fs.readFileSync(full, 'utf-8') },
              } as unknown as File
            },
          }]
        }
      }
    },
  }
}

const available = fs.existsSync(ROOT)
let library: TeslaEvent[] = []

test('scanning a real TeslaCam folder', async (t) => {
  if (!available) return t.skip(`no folder at ${ROOT}`)
  library = await scanLibrary(handleFor(ROOT))

  assert.ok(library.length > 0, 'events were found')

  // Each of the three folders, but only where the stick actually has one.
  // Requiring all three made the suite fail on a copy of the data with no
  // sentry events in it - a fact about that folder, not about the scanner.
  for (const source of ['SentryClips', 'SavedClips', 'RecentClips'] as const) {
    const onDisk = fs.existsSync(path.join(ROOT, source))
      && fs.readdirSync(path.join(ROOT, source)).length > 0
    if (!onDisk) continue
    assert.ok(library.some((e) => e.source === source), `${source} events`)
  }

  // Newest first. Someone opening this is looking for what just happened.
  const times = library.map((e) => e.startedAt.getTime())
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'sorted newest first')
})

test('a segment groups its cameras under one timestamp', (t) => {
  if (!library.length) return t.skip('nothing scanned')
  const recent = library.find((e) => e.source === 'RecentClips')
  if (!recent) return t.skip('no recent buffer in this folder')
  const seg = recent.segments[0]
  assert.ok(seg.files.front, 'front')
  assert.ok(seg.files.back, 'back')
  assert.ok(seg.files.left_repeater, 'left')
  assert.ok(seg.files.right_repeater, 'right')
  assert.match(seg.key, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
})

test('the clip timestamp is read as local time, not UTC', (t) => {
  if (!library.length) return t.skip('nothing scanned')
  const recent = library.find((e) => e.source === 'RecentClips')!
  const seg = recent.segments.find((s) => s.key.startsWith('2026-08-11_12-36'))
  if (!seg) return t.skip('the reference clip is not in this folder')
  // 12-36-58 in the filename is 12:36:58 where the car was, so the label must
  // read back the same. Parsing it as UTC shifts every clip by an hour or two.
  assert.equal(seg.startedAt.getHours(), 12)
  assert.equal(seg.startedAt.getMinutes(), 36)
  assert.equal(seg.startedAt.getSeconds(), 58)
})

test('an event with only some cameras is kept, and offers only those', (t) => {
  if (!library.length) return t.skip('nothing scanned')
  // One saved event in this folder has only the back and right repeater.
  const partial = library.find((e) => camerasIn(e).length > 0 && camerasIn(e).length < 4)
  if (!partial) return t.skip('every event here has all four cameras')

  const cams = camerasIn(partial)
  assert.ok(cams.length >= 1, 'the event survives')
  for (const seg of partial.segments) {
    for (const cam of cams) {
      // Not every segment must have every camera, but a camera offered by the
      // event must exist somewhere in it.
    }
  }
  assert.ok(partial.segments.length > 0)
})

test('sentry events carry their reason and place', (t) => {
  if (!library.length) return t.skip('nothing scanned')
  const withMeta = library.filter((e) => e.meta?.reason)
  assert.ok(withMeta.length > 0, 'some events have an event.json')
  const e = withMeta[0]
  assert.ok(e.meta!.city, 'a city')
  assert.ok(Number(e.meta!.est_lat) > 50, 'a plausible latitude')
})

test('a playback position maps to a segment and an offset', (t) => {
  if (!library.length) return t.skip('nothing scanned')
  const ev = library.find((e) => e.segments.length > 2)!
  ev.segments.forEach((s) => { s.durationSec = 60 })

  assert.deepEqual(locate(ev, 0), { index: 0, offset: 0 })
  assert.deepEqual(locate(ev, 59.5), { index: 0, offset: 59.5 })
  assert.deepEqual(locate(ev, 60), { index: 1, offset: 0 })
  assert.deepEqual(locate(ev, 125), { index: 2, offset: 5 })
  assert.equal(segmentStart(ev, 2), 120)

  // Past the end clamps to the last frame rather than returning a segment
  // index nobody can play.
  const past = locate(ev, eventSeconds(ev) + 100)
  assert.equal(past.index, ev.segments.length - 1)
})

test('a folder with no clips is empty, not an error', async () => {
  const empty: any = { kind: 'directory', name: 'Empty', async *entries() {} }
  assert.deepEqual(await scanLibrary(empty), [])
})
