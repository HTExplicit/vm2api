import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OpenaiApiKeyEntry } from '@/types/panel-openai-apikey'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import { saveApiKey } from './key-api'
import { invalidateOpenaiApiKeys } from './queries'

export function ApiKeyBindDialog({
  item,
  onClose,
}: {
  item: OpenaiApiKeyEntry
  onClose: () => void
}) {
  const [secret, setSecret] = useState('')
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => saveApiKey(item, secret),
    onSuccess: async () => {
      setSecret('')
      toast.success(item.has_key ? '已替换 API Key' : '已绑定 API Key')
      await invalidateOpenaiApiKeys(qc)
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {item.has_key ? '替换 API Key' : '绑定已有 Key'}
          </DialogTitle>
          <DialogDescription className='break-all'>
            {item.email || item.slot_name} ·{' '}
            {item.organization_name || item.organization_id || '未知组织'}
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <div className='space-y-2'>
            <Label htmlFor='openai-key-secret'>官方 API Key</Label>
            <PasswordInput
              id='openai-key-secret'
              name='api_key'
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete='off'
              placeholder='sk-…'
              aria-describedby='openai-key-org-hint'
              required
            />
            <p
              id='openai-key-org-hint'
              className='text-xs text-muted-foreground'
            >
              请核对 Key 属于此账号关联的组织。
              {item.has_key
                ? '替换后保留原使用开关，旧 Key 的调用阻断会清除。'
                : '首次绑定后默认开启 API 使用。'}
            </p>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={save.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type='submit' disabled={!secret.trim() || save.isPending}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
