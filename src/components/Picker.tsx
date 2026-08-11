/**
 * Choosing the dashcam folder.
 *
 * Two ways in, because the good one is Chromium-only:
 *
 *   - `showDirectoryPicker()` hands back a handle we can walk lazily. A sentry
 *     folder is tens of gigabytes and this reads names, not bytes.
 *   - `<input webkitdirectory>` is the fallback. Safari and Firefox will read
 *     the whole tree into File objects up front, which is slower but works.
 *
 * Neither uploads anything. The files never leave the machine - the server
 * hosts this page and nothing else.
 */

import { useRef, useState } from 'react'
import type { TeslaEvent } from '../lib/library'
import { scanLibrary, type ScanProgress } from '../lib/library'

export function hasDirectoryPicker(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}

/** Rebuild a directory-handle-shaped object from a flat FileList, so the same
 *  scanner serves both routes rather than growing a second code path. */
function handleFromFileList(files: FileList): any {
  interface Node { dirs: Map<string, Node>; files: File[] }
  const root: Node = { dirs: new Map(), files: [] }

  for (const file of Array.from(files)) {
    const parts = (file.webkitRelativePath || file.name).split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)!
    }
    node.files.push(file)
  }

  // The picker gives paths relative to the chosen folder, so the first level
  // is that folder itself.
  const top = root.dirs.size === 1 && !root.files.length
    ? [...root.dirs.values()][0]
    : root

  const wrap = (node: Node, name: string): any => ({
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, child] of node.dirs) yield [n, wrap(child, n)]
      for (const f of node.files) {
        yield [f.name, { kind: 'file', name: f.name, async getFile() { return f } }]
      }
    },
  })
  return wrap(top, 'TeslaCam')
}

export default function Picker({ onLoaded }: { onLoaded: (events: TeslaEvent[]) => void }) {
  const [busy, setBusy] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const scan = async (handle: any) => {
    setError(null)
    setBusy({ folder: '…', events: 0 })
    try {
      const events = await scanLibrary(handle, setBusy)
      if (!events.length) {
        setError('Der er ingen TeslaCam-optagelser i den mappe. Vælg mappen der '
          + 'hedder TeslaCam, eller en af RecentClips, SavedClips og SentryClips.')
        return
      }
      onLoaded(events)
    } catch (e) {
      setError(e instanceof Error && e.name === 'AbortError'
        ? '' : 'Mappen kunne ikke læses.')
    } finally {
      setBusy(null)
    }
  }

  const pick = async () => {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'read' })
      await scan(handle)
    } catch (e) {
      // Cancelling the OS dialog throws. That is not an error worth showing.
      if ((e as Error)?.name !== 'AbortError') setError('Mappen kunne ikke åbnes.')
      setBusy(null)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-12">
      <span className="eyebrow">teslacam.cscloud.dk</span>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dine dashcam-optagelser</h1>
      <p className="mt-3 text-muted">
        Peg på din TeslaCam-mappe — på USB-stikken, et SD-kort eller en mappe på
        maskinen. Videoerne bliver liggende hvor de er.
      </p>
      <p className="mt-2 text-sm text-faint">
        Alt sker i din browser. Der bliver ikke sendt en eneste video nogen steder hen;
        serveren leverer kun siden.
      </p>

      {/* The fallback input is always in the DOM, hidden. Chromium gets the
          directory picker on the button; everyone else - and anyone who
          prefers the ordinary file dialog - uses the same input underneath. */}
      <input
        ref={input}
        type="file"
        className="sr-only"
        id="dirinput"
        // Not in the TS DOM lib, but every browser without the directory
        // picker supports it.
        {...{ webkitdirectory: '', directory: '' } as any}
        multiple
        onChange={(e) => e.target.files?.length && scan(handleFromFileList(e.target.files))}
      />

      <div className="mt-7 flex flex-wrap gap-3">
        {hasDirectoryPicker() ? (
          <button className="btn btn-primary" onClick={pick} disabled={Boolean(busy)}>
            Vælg TeslaCam-mappe
          </button>
        ) : (
          <label htmlFor="dirinput" className="btn btn-primary tap cursor-pointer">
            Vælg TeslaCam-mappe
          </label>
        )}
      </div>

      {!hasDirectoryPicker() && (
        <p className="mt-3 text-sm text-warn">
          Din browser kan ikke læse en mappe direkte. Det virker stadig, men den
          skal igennem hele mappen først, og det tager længere tid. Chrome og Edge
          er hurtigere her.
        </p>
      )}

      {busy && (
        <p role="status" className="mt-5 text-sm text-muted">
          Læser {busy.folder}… <span className="num">{busy.events}</span> optagelser fundet
        </p>
      )}
      {error && <p role="alert" className="mt-5 text-sm text-warn">{error}</p>}

      <div className="card mt-10 px-5 py-4">
        <h2 className="eyebrow">Hvad appen kan</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          <li>Se alle fire kameraer samtidig, i bilens eget layout</li>
          <li>Slå kameraer til og fra, og skifte mellem layouts</li>
          <li>Vise fart, gear, blinklys og bremse fra bilens egen telemetri</li>
          <li>Eksportere det du ser som en MP4-fil</li>
        </ul>
        <p className="mt-3 text-xs text-faint">
          Telemetrien ligger inde i videoen og skrives kun af firmware 2025.44.25
          og nyere. Ældre optagelser har den ikke, og så siger appen det.
        </p>
      </div>
    </main>
  )
}
