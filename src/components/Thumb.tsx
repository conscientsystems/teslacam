/**
 * The picture on a library card.
 *
 * Saved and sentry events ship a thumb.png, which is free. RecentClips does
 * not, so one frame is grabbed from the front camera - and only when the card
 * scrolls into view, because a stick with six hundred events would otherwise
 * open six hundred 40 MB videos on first paint.
 */

import { useEffect, useRef, useState } from 'react'
import type { TeslaEvent } from '../lib/library'

export default function Thumb({ event }: { event: TeslaEvent }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = box.current
    if (!el || visible) return
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); io.disconnect() }
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let dead = false
    let objectUrl: string | null = null

    const cleanup = () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }

    if (event.thumb) {
      objectUrl = URL.createObjectURL(event.thumb)
      setUrl(objectUrl)
      return cleanup
    }

    // No thumb.png: pull a frame out of the first front clip.
    const file = event.segments[0]?.files.front ?? Object.values(event.segments[0]?.files ?? {})[0]
    if (!file) { setFailed(true); return }

    const src = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.src = src
    // A second in, rather than frame zero: the first frame of a dashcam clip is
    // often still adjusting exposure and comes out white or black.
    video.currentTime = 1

    const draw = () => {
      if (dead) return
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(src)
        if (dead || !blob) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }, 'image/jpeg', 0.7)
    }

    video.addEventListener('seeked', draw, { once: true })
    video.addEventListener('error', () => { URL.revokeObjectURL(src); setFailed(true) }, { once: true })

    return () => { dead = true; URL.revokeObjectURL(src); cleanup() }
  }, [visible, event])

  return (
    <div ref={box} className="aspect-[4/3] w-full bg-raised">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className={`h-full w-full ${failed ? '' : 'animate-pulse'}`} />
      )}
    </div>
  )
}
