import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  CLASSIC_COLUMNS,
  COLUMNS,
  METRIC_COLUMNS,
  type ColumnKey,
  type useListColumns,
} from './vm-list-columns'

export function VmColumnPicker({
  columns,
}: {
  columns: ReturnType<typeof useListColumns>
}) {
  function choices(label: string, keys: readonly ColumnKey[]) {
    return (
      <fieldset>
        <legend className='mb-1 text-xs font-semibold'>{label}</legend>
        <div className='grid grid-cols-2 gap-x-2'>
          {keys.map((key) => (
            <label
              key={key}
              className='flex min-h-8 items-center gap-2 text-xs'
            >
              <input
                type='checkbox'
                className='size-4 accent-primary'
                checked={columns.visible.includes(key)}
                disabled={key === 'vm'}
                onChange={() => columns.toggle(key)}
              />
              {COLUMNS[key].label}
              {key === 'vm' ? (
                <small className='text-muted-foreground'>固定</small>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type='button' size='sm' variant='outline'>
          <Columns3 aria-hidden />
          显示列
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        aria-label='显示列'
        className='flex max-h-[min(80dvh,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-2rem))] flex-col gap-3'
      >
        <div className='min-h-0 space-y-3 overflow-y-auto overscroll-contain'>
          {choices('经典列', CLASSIC_COLUMNS)}
          {choices('新增指标', METRIC_COLUMNS)}
          <details>
            <summary className='cursor-pointer text-xs font-medium'>
              调整列顺序
            </summary>
            <ol className='mt-1'>
              {columns.visible.slice(1).map((key, i, keys) => (
                <li key={key} className='flex items-center gap-1 text-xs'>
                  <span className='flex-1'>{COLUMNS[key].label}</span>
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-7'
                    disabled={i === 0}
                    aria-label={`前移${COLUMNS[key].label}`}
                    onClick={() => columns.move(key, keys[i - 1])}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-7'
                    disabled={i === keys.length - 1}
                    aria-label={`后移${COLUMNS[key].label}`}
                    onClick={() => columns.move(key, keys[i + 1])}
                  >
                    <ArrowDown />
                  </Button>
                </li>
              ))}
            </ol>
          </details>
        </div>
        <div className='flex items-center justify-between border-t pt-2'>
          <span className='text-xs text-muted-foreground'>
            显示 {columns.visible.length} 列
          </span>
          <Button size='sm' variant='outline' onClick={columns.reset}>
            恢复官方布局
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
