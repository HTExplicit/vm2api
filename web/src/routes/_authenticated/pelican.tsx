import { createFileRoute } from '@tanstack/react-router'
import { PelicanPage } from '@/features/pelican'

export const Route = createFileRoute('/_authenticated/pelican')({
  component: PelicanPage,
})
