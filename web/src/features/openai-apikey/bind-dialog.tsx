import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  OpenaiApiBindCandidate,
  OpenaiApiKeyEntry,
} from '@/types/panel-openai-apikey'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PasswordInput } from '@/components/password-input'
import { saveApiKey } from './key-api'
import { targetId } from './key-display'
import { invalidateOpenaiApiKeys } from './queries'

export function ApiKeyBindDialog({
  candidates,
  replacing,
  onClose,
}: {
  candidates: OpenaiApiBindCandidate[]
  replacing?: OpenaiApiKeyEntry | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState('')
  const [secret, setSecret] = useState('')
  const target =
    replacing ||
    candidates.find((candidate) => targetId(candidate) === selected)
  const save = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error('请选择已领取赠额的账号')
      await saveApiKey(target, secret)
    },
    onSuccess: async () => {
      setSecret('')
      onClose()
      toast.success(replacing ? '官方 key 已替换' : '官方 key 已绑定')
      await invalidateOpenaiApiKeys(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {replacing ? '替换官方 key' : '绑定已有 key'}
          </DialogTitle>
          <DialogDescription>
            录入该账号的 OpenAI 官方 key，所有调用使用账号当前绑定代理。
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
            <Label htmlFor='openai-key-account'>来源账号</Label>
            {replacing ? (
              <p className='text-sm break-all'>{replacing.email}</p>
            ) : (
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id='openai-key-account'>
                  <SelectValue placeholder='选择已领取或发放中的账号' />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem
                      key={targetId(candidate)}
                      value={targetId(candidate)}
                    >
                      {candidate.email} ·{' '}
                      {candidate.slot_name || candidate.vm_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!replacing && candidates.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                暂无可绑定账号。请先在账号页领取赠额，已领取或发放中且未保存 key
                的账号会出现在这里。
              </p>
            ) : null}
          </div>
          <div className='space-y-2'>
            <Label htmlFor='openai-key-secret'>官方 API key</Label>
            <PasswordInput
              id='openai-key-secret'
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete='off'
              placeholder='sk-…'
              required
            />
            <p className='text-xs leading-relaxed text-muted-foreground'>
              直接保存，不发起官方验证或模型请求。请核对 key
              属于此账号关联的组织。
              {replacing
                ? '替换会保留使用开关，并清除旧 key 的调用阻断；旧官方 key 不会被撤销。'
                : '首次绑定默认开启 API 使用。'}
            </p>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={onClose}
              disabled={save.isPending}
            >
              取消
            </Button>
            <Button
              type='submit'
              disabled={!target || !secret.trim() || save.isPending}
            >
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
