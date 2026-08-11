/**
 * Exporting what you are looking at.
 *
 * The range is in whole segments, because that is the unit the files come in
 * and cutting inside one would mean re-encoding from a keyframe for no real
 * gain. A ten-minute sentry event is ten one-minute files; you almost always
 * want two of them.
 */

import { useEffect, useRef, useState } from 'react'
import type { LayoutName, OverlayOptions } from '../lib/compose'
import { canExport, exportName, exportVideo, type ExportProgress } from '../lib/export'
import type { Camera, TeslaEvent } from '../lib/library'

export default function ExportPanel({ event, cameras, layout, overlay, onClose }: {
  event: TeslaEvent
  cameras: Camera[]
  layout: LayoutName
  overlay: OverlayOptions
  onClose: () => void
}) {
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(Math.min(event.segments.length - 1, 0))
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ url: string; name: string; bytes: number } | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => { if (done) URL.revokeObjectURL(done.url) }, [done])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !progress && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, progress])

  const run = async () => {
    setError(null)
    setDone(null)
    abort.current = new AbortController()
    const req = {
      event, cameras, layout, overlay,
      fromSegment: Math.min(from, to),
      toSegment: Math.max(from, to),
      lang: 'da' as const,
    }
    try {
      const blob = await exportVideo(req, setProgress, abort.current.signal)
      setDone({ url: URL.createObjectURL(blob), name: exportName(req), bytes: blob.size })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eksporten mislykkedes')
    } finally {
      setProgress(null)
    }
  }

  const segCount = Math.abs(to - from) + 1
  const seconds = segCount * 60

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Luk" tabIndex={-1} className="absolute inset-0 bg-black/70"
              onClick={() => !progress && onClose()} />
      <div role="dialog" aria-modal="true" aria-label="Eksportér"
           className="card relative w-full max-w-lg rounded-b-none sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold">Eksportér som video</h2>
          <button className="btn !min-h-0 !px-2 !py-1" onClick={onClose} disabled={Boolean(progress)}>
            Luk
          </button>
        </header>

        <div className="scroll max-h-[70dvh] space-y-4 px-5 py-4">
          <div>
            <span className="eyebrow">Hvilke klip</span>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-sm">
                Fra
                <select className="chip mt-1 w-full !justify-between" value={from}
                        onChange={(e) => setFrom(Number(e.target.value))}>
                  {event.segments.map((s, i) => (
                    <option key={s.key} value={i}>{i + 1}. {clockOf(s.startedAt)}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Til
                <select className="chip mt-1 w-full !justify-between" value={to}
                        onChange={(e) => setTo(Number(e.target.value))}>
                  {event.segments.map((s, i) => (
                    <option key={s.key} value={i}>{i + 1}. {clockOf(s.startedAt)}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="num mt-2 text-xs text-faint">
              {segCount} klip, cirka {Math.round(seconds / 60)} minutter
            </p>
          </div>

          <div className="rounded-lg border border-line px-3 py-2 text-sm text-muted">
            Eksporten bruger de kameraer, det layout og de indstillinger du har valgt
            på afspilleren — {cameras.length} kamera{cameras.length === 1 ? '' : 'er'},
            {overlay.speed ? ' med fart' : ' uden fart'},
            {overlay.clock ? ' med dato og tid' : ' uden dato og tid'}.
          </div>

          {!canExport() && (
            <p className="text-sm text-warn">
              Din browser understøtter ikke WebCodecs, som eksporten bruger. Chrome,
              Edge og nyere Safari kan. Alt andet i appen virker.
            </p>
          )}

          {progress && (
            <div>
              <p role="status" className="num text-sm text-muted">
                {phaseText(progress)} — {Math.round(progress.fraction * 100)}%
              </p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-live transition-[width]"
                     style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-faint">
                Det hele sker på din maskine, så det tager tid. Lad fanen være åben.
              </p>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-warn">{error}</p>}

          {done && (
            <div className="rounded-lg border border-live px-3 py-3">
              <p className="text-sm">Klar. {(done.bytes / 1e6).toFixed(1)} MB.</p>
              <a className="btn btn-primary mt-2 inline-flex" href={done.url} download={done.name}>
                Hent {done.name}
              </a>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-5 py-4">
          {progress ? (
            <button className="btn" onClick={() => abort.current?.abort()}>Afbryd</button>
          ) : (
            <button className="btn btn-primary" onClick={run}
                    disabled={!canExport() || !cameras.length}>
              Start eksport
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function clockOf(d: Date): string {
  return d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function phaseText(p: ExportProgress): string {
  const where = `klip ${p.segment} af ${p.segments}`
  switch (p.phase) {
    case 'decoding': return `Læser ${where}`
    case 'encoding': return `Tegner og koder ${where}`
    case 'writing': return 'Skriver filen'
    case 'done': return 'Færdig'
    default: return 'Klargør'
  }
}
