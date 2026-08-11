/**
 * Turning a TeslaCam folder into something you can browse.
 *
 * The layout, as it actually appears on the USB stick:
 *
 *   TeslaCam/
 *     RecentClips/                      flat, a rolling buffer, no event.json
 *       2026-08-11_12-36-58-front.mp4
 *       2026-08-11_12-36-58-back.mp4
 *       2026-08-11_12-36-58-left_repeater.mp4
 *       2026-08-11_12-36-58-right_repeater.mp4
 *     SavedClips/2024-05-04_12-25-52/   one folder per event
 *       event.json  thumb.png  <segments>
 *     SentryClips/2024-05-01_09-58-39/
 *
 * Two things this has to survive, both present in the real folder:
 *
 *   - **A segment can be missing cameras.** One saved event here has only the
 *     back and right repeater. Assuming four files per timestamp drops the
 *     whole segment.
 *   - **RecentClips is not one continuous recording.** It is whatever the
 *     buffer holds, so consecutive timestamps can be minutes apart.
 */

export const CAMERAS = ['front', 'left_repeater', 'right_repeater', 'back'] as const
export type Camera = (typeof CAMERAS)[number]

/** What each camera is called on screen. Tesla's own names are positional
 *  ("repeater" is the indicator housing); the labels match the car's UI. */
export const CAMERA_LABEL: Record<Camera, { da: string; en: string }> = {
  front: { da: 'Front', en: 'Front' },
  left_repeater: { da: 'Venstre', en: 'Left' },
  right_repeater: { da: 'Højre', en: 'Right' },
  back: { da: 'Bag', en: 'Back' },
}

export type Source = 'RecentClips' | 'SavedClips' | 'SentryClips'

export interface Segment {
  /** The shared filename prefix, e.g. 2026-08-11_12-36-58. */
  key: string
  startedAt: Date
  files: Partial<Record<Camera, File>>
  /** Filled in lazily once a video reports it; segments are about 60 s. */
  durationSec?: number
}

export interface TeslaEvent {
  id: string
  source: Source
  /** Folder name for saved and sentry events; the source name for recent. */
  name: string
  startedAt: Date
  segments: Segment[]
  thumb?: File
  meta?: EventMeta
}

export interface EventMeta {
  timestamp?: string
  city?: string
  est_lat?: string
  est_lon?: string
  reason?: string
  camera?: string
}

/** Sentry's own words for why it started recording. */
export const REASON_LABEL: Record<string, { da: string; en: string }> = {
  sentry_aware_object_detection: { da: 'Bevægelse registreret', en: 'Motion detected' },
  user_interaction_dashcam_icon_tapped: { da: 'Du trykkede på dashcam-ikonet', en: 'Dashcam icon tapped' },
  user_interaction_honk: { da: 'Hornet blev brugt', en: 'Horn used' },
  sentry_accel_threshold: { da: 'Bilen blev rørt', en: 'Impact detected' },
}

const NAME = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)\.mp4$/i

/** The timestamp in a clip's name is local time in the car. Parsing it as UTC
 *  would shift every label by an hour or two depending on the season. */
function parseStamp(date: string, h: string, m: string, s: string): Date {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, Number(h), Number(m), Number(s))
}

function isCamera(x: string): x is Camera {
  return (CAMERAS as readonly string[]).includes(x)
}

/** Group the mp4s in one directory listing into segments. */
function toSegments(files: File[]): Segment[] {
  const byKey = new Map<string, Segment>()
  for (const file of files) {
    const m = NAME.exec(file.name)
    if (!m) continue
    const [, date, hh, mm, ss, cam] = m
    if (!isCamera(cam)) continue          // pillar cameras on newer cars, etc.
    const key = `${date}_${hh}-${mm}-${ss}`
    let seg = byKey.get(key)
    if (!seg) {
      seg = { key, startedAt: parseStamp(date, hh, mm, ss), files: {} }
      byKey.set(key, seg)
    }
    seg.files[cam] = file
  }
  return [...byKey.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
}

export interface ScanProgress {
  folder: string
  events: number
}

/**
 * Walk a directory handle into events.
 *
 * Nothing is read here beyond names and the small event.json - the videos stay
 * on disk as File handles until something asks to play or export them. A sentry
 * folder can hold several gigabytes and this has to feel instant.
 */
export async function scanLibrary(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: ScanProgress) => void,
): Promise<TeslaEvent[]> {
  const events: TeslaEvent[] = []

  // A folder chosen *inside* TeslaCam should still work - people pick
  // SentryClips as often as the parent.
  const top = await listDirs(root)
  const sources = (['RecentClips', 'SavedClips', 'SentryClips'] as Source[])
    .filter((s) => top.has(s))

  if (!sources.length) {
    // The picked folder may itself be one of the three, or a single event.
    const own = await readEventFolder(root, guessSource(root.name), root.name)
    return own ? [own] : []
  }

  for (const source of sources) {
    const dir = top.get(source)!
    onProgress?.({ folder: source, events: events.length })

    if (source === 'RecentClips') {
      const files = await listFiles(dir)
      const segments = toSegments(files)
      if (segments.length) {
        events.push({
          id: 'recent',
          source,
          name: 'RecentClips',
          startedAt: segments[0].startedAt,
          segments,
          thumb: files.find((f) => f.name === 'thumb.png'),
        })
      }
      continue
    }

    for (const [name, handle] of await listDirs(dir)) {
      const ev = await readEventFolder(handle, source, name)
      if (ev) {
        events.push(ev)
        if (events.length % 25 === 0) onProgress?.({ folder: source, events: events.length })
      }
    }
  }

  // Newest first: the reason anyone opens this is something that just happened.
  events.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  return events
}

function guessSource(name: string): Source {
  if (name === 'SavedClips' || name === 'SentryClips' || name === 'RecentClips') return name
  return 'SavedClips'
}

async function readEventFolder(
  dir: FileSystemDirectoryHandle, source: Source, name: string,
): Promise<TeslaEvent | null> {
  const files = await listFiles(dir)
  const segments = toSegments(files)
  if (!segments.length) return null

  let meta: EventMeta | undefined
  const metaFile = files.find((f) => f.name === 'event.json')
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.text()) as EventMeta
    } catch {
      // A truncated event.json is common on a stick pulled mid-write. The
      // clips are still perfectly playable, so this must not lose the event.
      meta = undefined
    }
  }

  return {
    id: `${source}/${name}`,
    source,
    name,
    // event.json's timestamp is when sentry triggered, which is a few seconds
    // into the recording. The first segment is when the video starts.
    startedAt: segments[0].startedAt,
    segments,
    thumb: files.find((f) => f.name === 'thumb.png'),
    meta,
  }
}

async function listFiles(dir: FileSystemDirectoryHandle): Promise<File[]> {
  const out: File[] = []
  for await (const [, handle] of (dir as any).entries()) {
    if (handle.kind === 'file') out.push(await handle.getFile())
  }
  return out
}

async function listDirs(
  dir: FileSystemDirectoryHandle,
): Promise<Map<string, FileSystemDirectoryHandle>> {
  const out = new Map<string, FileSystemDirectoryHandle>()
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind === 'directory') out.set(name, handle)
  }
  return out
}

/** Total running time of an event, assuming the usual minute per segment.
 *  Replaced with measured durations once the videos have loaded. */
export function eventSeconds(event: TeslaEvent): number {
  return event.segments.reduce((n, s) => n + (s.durationSec ?? 60), 0)
}

/** Which cameras this event has any footage from at all. A saved event with
 *  only two cameras must not offer four checkboxes. */
export function camerasIn(event: TeslaEvent): Camera[] {
  const seen = new Set<Camera>()
  for (const seg of event.segments) {
    for (const cam of CAMERAS) if (seg.files[cam]) seen.add(cam)
  }
  return CAMERAS.filter((c) => seen.has(c))
}

/** Where a playback position lands: which segment, and how far into it. */
export function locate(event: TeslaEvent, t: number): { index: number; offset: number } {
  let acc = 0
  for (let i = 0; i < event.segments.length; i++) {
    const d = event.segments[i].durationSec ?? 60
    if (t < acc + d) return { index: i, offset: t - acc }
    acc += d
  }
  const last = event.segments.length - 1
  return { index: last, offset: event.segments[last]?.durationSec ?? 60 }
}

/** The playback position at which a segment starts. */
export function segmentStart(event: TeslaEvent, index: number): number {
  let acc = 0
  for (let i = 0; i < index; i++) acc += event.segments[i].durationSec ?? 60
  return acc
}
