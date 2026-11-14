#!/usr/bin/env node
/** Publish the image's signed factory package without selecting or activating it. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cragV2Arch, cragV2PackageRoot, stageCragV2Tree, verifyCragV2Tree } from '../src/lib/vm/wrap-cli-runtime.mjs'

export function publishCragFactory(
  root,
  source = '/opt/vm2api/image-crag/kernels/v2/amd64',
  { arch = cragV2Arch() } = {},
) {
  if (arch !== 'amd64') return { ok: true, skipped: true, reason: 'unsupported_arch' }
  if (String(process.env.KIN_CRAG_V2_ROOT || '').trim()) {
    return { ok: true, skipped: true, reason: 'custom_package' }
  }
  if (!fs.existsSync(path.join(source, 'manifest.json'))) return { ok: true, skipped: true }
  const checked = verifyCragV2Tree(source)
  if (!checked.ok) throw new Error(`CRAG image factory invalid: ${checked.code}`)
  const destination = path.join(root, 'share/crag/kernels/v2/amd64')
  const authority = (dir) =>
    crypto
      .createPublicKey(fs.readFileSync(path.join(dir, 'crag-license-public.pem')))
      .export({ format: 'der', type: 'spki' })
  const incoming = authority(source)
  const selected = cragV2PackageRoot(root)
  for (const existing of new Set([selected, fs.existsSync(destination) ? destination : ''].filter(Boolean))) {
    const verified = verifyCragV2Tree(existing)
    if (!verified.ok) throw new Error(`Existing CRAG package invalid: ${verified.code}`)
    if (!incoming.equals(authority(existing))) throw new Error('CRAG factory authority mismatch')
  }
  if (
    fs.existsSync(path.join(destination, 'manifest.json')) &&
    fs.readFileSync(path.join(source, 'manifest.json')).equals(fs.readFileSync(path.join(destination, 'manifest.json')))
  ) {
    return { ok: true, changed: false }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const staged = stageCragV2Tree(source, destination)
  if (!staged.ok) throw new Error(`CRAG factory publication failed: ${staged.code}`)
  try {
    // Slot publication retains old Claude paths for running processes; the
    // factory must remain an exact signed package for the downloader's anchor.
    for (const name of fs.readdirSync(destination)) {
      if (name.startsWith('claude-code-') && !fs.existsSync(path.join(source, name))) {
        fs.rmSync(path.join(destination, name), { recursive: true })
      }
    }
    const verified = verifyCragV2Tree(destination)
    if (!verified.ok) throw new Error(`Published CRAG factory invalid: ${verified.code}`)
    staged.commit()
  } catch (error) {
    staged.rollback()
    throw error
  }
  return { ok: true, changed: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(publishCragFactory(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api')))
}
