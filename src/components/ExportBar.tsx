/**
 * Exporting the selection, without leaving the picture.
 *
 * This used to be a modal: it covered the video, and it asked again for the
 * range you had just chosen. The range now lives on the timeline, so all that
 * is left is a button, a progress bar and a download - and they belong next to
 * the thing they act on.
 */

import { useEffect, useRef, useState } from 'react'
import type { LayoutName, OverlayOptions } from '../lib/compose'
import { canExport, exportName, exportVideo, type ExportProgress } from '../lib/export'
import type { Camera, TeslaEvent } from '../lib/library'

export default function ExportBar({
  event, cameras, layout, overlay, fromSec, toSec, onBusy,
}: {
  event: TeslaEvent
  cameras: Camera[]
  layout: LayoutName
  overlay: OverlayOptions
  fromSec: number
  toSec: number
  /** The player is unmounted while this runs: four <video> elements hold four
   *  decoders, and with them alive the exporter's own decoder never produces a
   *  frame - the job sits at 0% forever. */
  onBusy: (busy: boolean) => void
}) {
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ url: string; name: string; bytes: number } | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => { if (done) URL.revokeObjectURL(done.url) }, [done])

  const run = async () => {
    setError(null)
    if (done) { URL.revokeObjectURL(done.url); setDone(null) }
    abort.current = new AbortController()
    const req = { event, cameras, layout, overlay, fromSec, toSec, lang: 'da' as const }
    onBusy(true)
    try {
      const blob = await exportVideo(req, setProgress, abort.current.signal)
      setDone({ url: URL.createObjectURL(blob), name: exportName(req), bytes: blob.size })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eksporten mislykkedes')
    } finally {
      setProgress(null)
      onBusy(false)
    }
  }

  const secs = Math.max(0, toSec - fromSec)

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-3">
        {progress ? (
          <button className="btn" onClick={() => abort.current?.abort()}>Afbryd</button>
        ) : (
          <button className="btn btn-primary" onClick={run}
                  disabled={!canExport() || !cameras.length || secs < 0.5}>
            Eksportér markeringen
          </button>
        )}
        <p className="num text-sm text-faint">
          {Math.round(secs)} sekunder · {cameras.length} kamera{cameras.length === 1 ? '' : 'er'}
          {overlay.speed ? ' · med fart' : ''}
          {overlay.clock ? ' · med dato og tid' : ''}
        </p>

        {done && (
          <a className="btn btn-primary ml-auto" href={done.url} download={done.name}>
            Hent {(done.bytes / 1e6).toFixed(1)} MB
          </a>
        )}
      </div>

      {progress && (
        <div className="mt-3">
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

      {error && <p role="alert" className="mt-2 text-sm text-warn">{error}</p>}

      {!canExport() && (
        <p className="mt-2 text-sm text-warn">
          Din browser understøtter ikke WebCodecs, som eksporten bruger. Chrome,
          Edge og nyere Safari kan. Alt andet i appen virker.
        </p>
      )}
    </div>
  )
}

function phaseText(p: ExportProgress): string {
  const where = p.segments > 1 ? `del ${p.segment} af ${p.segments}` : 'markeringen'
  switch (p.phase) {
    case 'decoding': return `Læser ${where}`
    case 'encoding': return `Tegner og koder ${where}`
    case 'writing': return 'Skriver filen'
    case 'done': return 'Færdig'
    default: return 'Klargør'
  }
}
