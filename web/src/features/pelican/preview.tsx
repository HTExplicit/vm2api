import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Every result uses the same canvas, so card density never changes the artwork. */
export function PelicanPreview({
  html,
  title,
  className,
}: {
  html: string
  title: string
  className?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / 960)
    })
    observer.observe(container.current!)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={container}
      className={cn(
        'relative aspect-[8/5] w-full overflow-hidden bg-white',
        className
      )}
    >
      <iframe
        title={title}
        srcDoc={html}
        sandbox='allow-scripts'
        referrerPolicy='no-referrer'
        width={960}
        height={600}
        className='absolute top-0 left-0 origin-top-left border-0'
        style={{
          transform: `scale(${scale})`,
          visibility: scale ? 'visible' : 'hidden',
        }}
      />
    </div>
  )
}
