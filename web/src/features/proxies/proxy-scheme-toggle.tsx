import { useId } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ProxyScheme } from './proxy-scheme'

const OPTIONS: { value: ProxyScheme; label: string }[] = [
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP' },
]

/** 代理协议为互斥选项，复用 RadioGroup 的焦点和键盘行为。 */
export function ProxySchemeToggle({
  value,
  onChange,
  disabled,
  className,
  label = '协议',
}: {
  value: ProxyScheme
  onChange: (value: ProxyScheme) => void
  disabled?: boolean
  className?: string
  label?: string
}) {
  const id = useId()
  return (
    <div className={cn('space-y-1', className)}>
      <Label id={`${id}-label`}>{label}</Label>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={value}
        onValueChange={(next) => onChange(next as ProxyScheme)}
        orientation='horizontal'
        disabled={disabled}
        className='flex flex-wrap gap-x-4 gap-y-1 data-[disabled]:opacity-50'
      >
        {OPTIONS.map((opt) => (
          <div
            key={opt.value}
            className='flex min-h-8 items-center gap-2 [@media(pointer:coarse)]:min-h-12'
          >
            <RadioGroupItem id={`${id}-${opt.value}`} value={opt.value} />
            <Label
              htmlFor={`${id}-${opt.value}`}
              className='min-h-8 [@media(pointer:coarse)]:min-h-12'
            >
              {opt.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  )
}
