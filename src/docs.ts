import { createHash } from 'node:crypto'

import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionSlug, Payload, PayloadRequest } from 'payload'

import { idOf } from './api'
import { catalogStatus } from './catalog'
import type { ResolvedRoadmapOptions } from './types'

/** What a docs plugin's feature looks like. Kept here so this plugin imports nothing from it. */
export type DocsFeature = {
  id: string
  section: { key: string; title: string }
  title: string
  summary?: string
  details?: string
  stage: 'available' | 'members' | 'in-progress' | 'planned'
  links?: string[]
  version: string
}

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const optsOf = (payload: Payload) => payload.config.custom.roadmap as ResolvedRoadmapOptions

/** One catalog entry as a docs feature, or null when it isn't in the catalog (hidden, declined, no category). */
function featureOf(opts: ResolvedRoadmapOptions, item: Doc, category: Doc | null): DocsFeature | null {
  if (!opts.catalog || !category || item.hidden || item.mergedInto || !opts.catalog.boards.includes(String(item.board))) return null
  const status = catalogStatus(opts, String(item.stage), item.audience)
  if (!status) return null
  const details = ((item.details ?? []) as { text?: string }[]).map((d) => d.text ?? '').filter(Boolean).join('\n')
  const links = ((item.links ?? []) as { href?: string }[]).map((l) => l.href ?? '').filter((h) => h.startsWith('/'))
  const base = { id: String(item.id), section: { key: String(category.slug ?? category.id), title: String(category.title) }, title: String(item.title), summary: item.summary ?? undefined, details: details || undefined, stage: status, links }
  // The version changes whenever words a page is written from change.
  const version = createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 16)
  return { ...base, version }
}

async function categoryOf(payload: Payload, id: unknown, req?: Partial<PayloadRequest>): Promise<Doc | null> {
  const opts = optsOf(payload)
  const cid = idOf(id)
  if (!cid) return null
  return (await payload.findByID({ collection: opts.slugs.categories as CollectionSlug, id: cid, depth: 0, overrideAccess: true, disableErrors: true, ...(req ? { req: req as PayloadRequest } : {}) })) as Doc | null
}

/** Every catalog entry as a docs feature. Read with access overridden: docs pages are written for the public catalog. */
export async function docsFeatures(payload: Payload): Promise<DocsFeature[]> {
  const opts = optsOf(payload)
  if (!opts.catalog) return []
  const [items, categories] = await Promise.all([
    payload.find({ collection: opts.slugs.items as CollectionSlug, where: { and: [{ board: { in: opts.catalog.boards } }, { hidden: { not_equals: true } }, { category: { exists: true } }] }, pagination: false, depth: 0, overrideAccess: true, joins: false }),
    payload.find({ collection: opts.slugs.categories as CollectionSlug, pagination: false, depth: 0, overrideAccess: true }),
  ])
  const byId = new Map((categories.docs as Doc[]).map((c) => [String(c.id), c]))
  return (items.docs as Doc[]).map((i) => featureOf(opts, i, byId.get(String(idOf(i.category))) ?? null)).filter((f): f is DocsFeature => f !== null)
}

type OnFeatureChange = (payload: Payload, args: { source: string; feature?: DocsFeature; removedId?: string; req?: Partial<PayloadRequest> }) => Promise<unknown>
const notify = (payload: Payload) => (payload.config.custom?.docs as { onFeatureChange?: OnFeatureChange } | undefined)?.onFeatureChange

/** Tells the docs plugin, when it's there, that an entry changed. Never throws: a docs problem can't break an edit. */
export const docsAfterChange: CollectionAfterChangeHook = async ({ doc, req }) => {
  const opts = optsOf(req.payload)
  const fn = notify(req.payload)
  if (!fn || !opts.catalog?.docs) return doc
  try {
    const feature = featureOf(opts, doc, await categoryOf(req.payload, doc.category, req))
    await fn(req.payload, feature ? { source: opts.catalog.docs.name, feature, req } : { source: opts.catalog.docs.name, removedId: String(doc.id), req })
  } catch (error) {
    req.payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'roadmap: the docs page for a catalog entry was not updated; the nightly sync will catch it' })
  }
  return doc
}

export const docsAfterDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  const opts = optsOf(req.payload)
  const fn = notify(req.payload)
  if (!fn || !opts.catalog?.docs) return doc
  try {
    await fn(req.payload, { source: opts.catalog.docs.name, removedId: String(doc.id), req })
  } catch (error) {
    req.payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'roadmap: the docs page for a deleted catalog entry was not archived; the nightly sync will catch it' })
  }
  return doc
}
