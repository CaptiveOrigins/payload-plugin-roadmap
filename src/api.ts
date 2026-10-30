import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import type { ResolvedRoadmapOptions } from './types'

/**
 * Server helpers for voting and requests. They run with overrideAccess, so
 * call them from trusted code that has already checked who the user is and
 * which scope (site) they are acting in.
 */

export type RoadmapItemDoc = {
  id: string
  title: string
  board: string
  stage: string
  key: string
  voteCount?: number | null
  parent?: string | { id: string } | null
  [field: string]: unknown
}

export const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : '')
export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
/** The per-board identity of an item: its subject, else its slug. */
export const itemKey = (subject: unknown, slug: string) => (idOf(subject) ? `subject:${idOf(subject)}` : `slug:${slug}`)

export const optionsOf = (payload: Payload) => {
  const opts = payload.config.custom?.roadmap as ResolvedRoadmapOptions | undefined
  if (!opts) throw new Error('roadmapPlugin is not installed')
  return opts
}

const isDuplicate = (error: unknown) => {
  const e = error as { code?: number; cause?: { code?: number }; data?: { errors?: { message?: string }[] }; message?: string }
  return e?.code === 11000 || e?.cause?.code === 11000 || /duplicate|unique|E11000/i.test(e?.message ?? '')
}

/** Set the stored count from the votes themselves (never incremented, so it cannot drift). */
export async function recountVotes(payload: Payload, item: string, req?: PayloadRequest) {
  const opts = optionsOf(payload)
  const { totalDocs } = await payload.count({
    collection: opts.slugs.votes as CollectionSlug,
    where: { item: { equals: item } },
    overrideAccess: true,
    req,
  })
  await payload.update({
    collection: opts.slugs.items as CollectionSlug,
    id: item,
    data: { voteCount: totalDocs } as never,
    overrideAccess: true,
    context: { roadmapInternal: true },
    req,
  })
  return totalDocs
}

const findVote = async (payload: Payload, item: string, user: string) =>
  (
    await payload.find({
      collection: optionsOf(payload).slugs.votes as CollectionSlug,
      where: { and: [{ item: { equals: item } }, { user: { equals: user } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as { id: string } | undefined

/** One vote per user per item: returns the existing vote if there is one. */
export async function castVote(payload: Payload, args: { item: string; user: string; note?: string }) {
  const existing = await findVote(payload, args.item, args.user)
  if (existing) return { vote: existing, created: false }
  try {
    const vote = (await payload.create({
      collection: optionsOf(payload).slugs.votes as CollectionSlug,
      data: { item: args.item, user: args.user, note: args.note || undefined } as never,
      overrideAccess: true,
      // Outside a transaction: a concurrent duplicate fails cleanly on the unique index.
      disableTransaction: true,
    })) as { id: string }
    return { vote, created: true }
  } catch (error) {
    if (!isDuplicate(error)) throw error
    return { vote: (await findVote(payload, args.item, args.user))!, created: false }
  }
}

export async function removeVote(payload: Payload, args: { item: string; user: string }) {
  const existing = await findVote(payload, args.item, args.user)
  if (!existing) return false
  await payload.delete({ collection: optionsOf(payload).slugs.votes as CollectionSlug, id: existing.id, overrideAccess: true })
  return true
}

/** The item for this subject (or slug) on a board, within a scope. */
export async function findItem(payload: Payload, args: { board: string; key: string; scope?: string }) {
  const opts = optionsOf(payload)
  const and: Where[] = [{ board: { equals: args.board } }, { key: { equals: args.key } }]
  if (opts.scopeField && args.scope) and.push({ [opts.scopeField]: { equals: args.scope } })
  return (
    await payload.find({ collection: opts.slugs.items as CollectionSlug, where: { and }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as unknown as RoadmapItemDoc | undefined
}

/**
 * Request something: finds the existing item for the subject (or title) or
 * creates one in the first stage, then adds the user's vote.
 */
export async function requestItem(
  payload: Payload,
  args: { board: string; title: string; subject?: string; scope?: string; user?: string; note?: string; data?: Record<string, unknown> },
) {
  const opts = optionsOf(payload)
  const key = itemKey(args.subject, slugify(args.title))
  let item = await findItem(payload, { board: args.board, key, scope: args.scope })
  let created = false
  if (!item) {
    try {
      item = (await payload.create({
        collection: opts.slugs.items as CollectionSlug,
        data: {
          ...args.data,
          title: args.title,
          board: args.board,
          stage: opts.stages[0]!.value,
          ...(opts.subject && args.subject ? { subject: args.subject } : {}),
          ...(opts.scopeField && args.scope ? { [opts.scopeField]: args.scope } : {}),
          ...(args.user ? { requestedBy: args.user } : {}),
        } as never,
        overrideAccess: true,
        disableTransaction: true,
      })) as unknown as RoadmapItemDoc
      created = true
    } catch (error) {
      if (!isDuplicate(error)) throw error
      item = (await findItem(payload, { board: args.board, key, scope: args.scope }))!
    }
  }
  const vote = args.user ? await castVote(payload, { item: item.id, user: args.user, note: args.note }) : null
  return { item, created, vote }
}
