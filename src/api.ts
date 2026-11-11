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

/** A unique-index conflict (raw driver error, or the Mongo adapter's "Value must be unique" ValidationError). */
const isDuplicate = (error: unknown) => {
  const e = error as { code?: number; cause?: { code?: number }; data?: { errors?: { message?: string }[] }; message?: string }
  return (
    e?.code === 11000 ||
    e?.cause?.code === 11000 ||
    /E11000|duplicate key/i.test(e?.message ?? '') ||
    Boolean(e?.data?.errors?.some((x) => /unique/i.test(x.message ?? '')))
  )
}

/** A user's free vote on an item has this ballot; placed (allocated) votes get a unique one each. */
export const FREE_BALLOT = 'free'

/** Refusals meant for the voter (not enough votes, still locked…). */
export class RoadmapError extends Error {}

type VoteDoc = { id: string; item: unknown; user: unknown; ballot?: string | null; slot?: string | null; weight?: number | null; createdAt: string }

/** Set the stored totals from the votes themselves (never incremented, so they cannot drift). */
export async function recountVotes(payload: Payload, item: string, req?: PayloadRequest) {
  const opts = optionsOf(payload)
  const { docs } = await payload.find({
    collection: opts.slugs.votes as CollectionSlug,
    where: { item: { equals: item } },
    pagination: false,
    depth: 0,
    select: { user: true, weight: true },
    overrideAccess: true,
    req,
  })
  const votes = docs as unknown as VoteDoc[]
  const voteCount = votes.reduce((n, v) => n + (v.weight ?? 1), 0)
  const voterCount = new Set(votes.map((v) => idOf(v.user))).size
  await payload.update({
    collection: opts.slugs.items as CollectionSlug,
    id: item,
    data: { voteCount, voterCount } as never,
    overrideAccess: true,
    context: { roadmapInternal: true },
    req,
  })
  return voteCount
}

const findVote = async (payload: Payload, item: string, user: string) =>
  (
    await payload.find({
      collection: optionsOf(payload).slugs.votes as CollectionSlug,
      where: { and: [{ item: { equals: item } }, { user: { equals: user } }, { ballot: { equals: FREE_BALLOT } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as { id: string } | undefined

/** The free vote: one per user per item; returns the existing vote if there is one. */
export async function castVote(payload: Payload, args: { item: string; user: string; note?: string }) {
  const existing = await findVote(payload, args.item, args.user)
  if (existing) return { vote: existing, created: false }
  try {
    const vote = (await payload.create({
      collection: optionsOf(payload).slugs.votes as CollectionSlug,
      data: { item: args.item, user: args.user, ballot: FREE_BALLOT, weight: 1, note: args.note || undefined } as never,
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

/** Remove the user's free vote (placed votes are withdrawn with `withdrawVotes`). */
export async function removeVote(payload: Payload, args: { item: string; user: string }) {
  const existing = await findVote(payload, args.item, args.user)
  if (!existing) return false
  await payload.delete({ collection: optionsOf(payload).slugs.votes as CollectionSlug, id: existing.id, overrideAccess: true })
  return true
}

const placedVotes = async (payload: Payload, user: string, scope?: string, item?: string) => {
  const opts = optionsOf(payload)
  const and: Where[] = [{ user: { equals: user } }, { ballot: { not_equals: FREE_BALLOT } }]
  if (opts.scopeField && scope) and.push({ [opts.scopeField]: { equals: scope } })
  if (item) and.push({ item: { equals: item } })
  return (
    await payload.find({
      collection: opts.slugs.votes as CollectionSlug,
      where: { and },
      pagination: false,
      depth: 0,
      sort: 'createdAt',
      overrideAccess: true,
    })
  ).docs as unknown as VoteDoc[]
}

const getItem = async (payload: Payload, id: string) =>
  (await payload.findByID({
    collection: optionsOf(payload).slugs.items as CollectionSlug,
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as unknown as RoadmapItemDoc | null

/** Whether an item's stage releases placed votes (e.g. "declined"). */
export const releases = (opts: ResolvedRoadmapOptions, stage?: string | null) =>
  Boolean(stage && opts.allocation?.releaseStages?.includes(stage))

const earnedVotes = async (payload: Payload, args: { user: string; scope?: string }) =>
  Math.floor((await optionsOf(payload).allocation!.earned({ payload, user: args.user, scope: args.scope })) + 1e-9)
const spentOn = (placed: VoteDoc[]) => placed.reduce((n, v) => n + (v.weight ?? 0), 0)

/** Earned, spent and available extra votes for a user (in a scope). */
export async function voteBalance(payload: Payload, args: { user: string; scope?: string }) {
  const opts = optionsOf(payload)
  if (!opts.allocation) return { earned: 0, spent: 0, available: 0 }
  const earned = await earnedVotes(payload, args)
  const spent = spentOn(await placedVotes(payload, args.user, args.scope))
  return { earned, spent, available: Math.max(0, earned - spent) }
}

/** The user's next placement slot in a scope: one more than the highest among `placed`. */
const nextSlot = (user: string, scope: string | undefined, placed: VoteDoc[]) => {
  const top = placed.reduce((n, v) => Math.max(n, Number(/:(\d+)$/.exec(v.slot ?? '')?.[1] ?? 0)), 0)
  return `${user}:${scope ?? ''}:${top + 1}`
}

/**
 * Place `votes` extra votes on an item, spent from the balance at once. Each
 * placement takes the user's next slot, which is unique across the votes
 * collection, so of two placements that read the same balance only one can
 * save; the other reads again and either places on the new balance or gets an
 * honest "not enough votes". The balance is also checked again after saving,
 * so an overspending placement is undone and refused, never kept.
 */
export async function allocateVotes(payload: Payload, args: { item: string; user: string; votes: number; scope?: string }, { attempts = 10 }: { attempts?: number } = {}) {
  const opts = optionsOf(payload)
  const votes = Math.floor(Number(args.votes))
  if (!opts.allocation) throw new RoadmapError('Extra votes are not enabled.')
  if (!(votes >= 1)) throw new RoadmapError('Choose at least one vote.')
  const item = await getItem(payload, args.item)
  if (!item || item.hidden) throw new RoadmapError('That roadmap item is not open for votes.')
  if (opts.allocation.boards && !opts.allocation.boards.includes(item.board)) throw new RoadmapError('Extra votes can’t be placed on this roadmap.')
  if (releases(opts, item.stage)) throw new RoadmapError('This item is not planned, so it can’t take extra votes.')
  for (let attempt = 1; ; attempt++) {
    const placed = await placedVotes(payload, args.user, args.scope)
    if ((await earnedVotes(payload, args)) - spentOn(placed) < votes) throw new RoadmapError('You don’t have that many votes available.')
    let vote: { id: string }
    try {
      vote = (await payload.create({
        collection: opts.slugs.votes as CollectionSlug,
        data: {
          item: args.item,
          user: args.user,
          ballot: `placed:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
          slot: nextSlot(args.user, args.scope, placed),
          weight: votes,
        } as never,
        overrideAccess: true,
        disableTransaction: true,
      })) as { id: string }
    } catch (error) {
      // Another placement took this slot first: read the new balance and try again.
      if (!isDuplicate(error)) throw error
      if (attempt >= attempts) throw new RoadmapError('Votes are being placed elsewhere at the same moment. Try again.')
      continue
    }
    const after = await voteBalance(payload, args)
    if (after.spent <= after.earned) return vote
    await payload.delete({ collection: opts.slugs.votes as CollectionSlug, id: vote.id, overrideAccess: true })
    throw new RoadmapError('You don’t have that many votes available.')
  }
}

/**
 * When placed votes can be withdrawn (ISO date), or null if now. Votes on an
 * item in a release stage can be withdrawn at once.
 */
export const unlocksAt = (opts: ResolvedRoadmapOptions, createdAt: string, stage?: string | null) => {
  if (releases(opts, stage)) return null
  const days = opts.allocation?.lockDays ?? 0
  const at = new Date(new Date(createdAt).getTime() + days * 864e5)
  return at.getTime() > Date.now() ? at.toISOString() : null
}

/** Return the user's unlocked placed votes on an item to their balance; locked ones stay. */
export async function withdrawVotes(payload: Payload, args: { item: string; user: string; scope?: string }) {
  const opts = optionsOf(payload)
  const stage = (await getItem(payload, args.item))?.stage
  let returned = 0
  for (const v of await placedVotes(payload, args.user, args.scope, args.item)) {
    if (unlocksAt(opts, v.createdAt, stage)) continue
    await payload.delete({ collection: opts.slugs.votes as CollectionSlug, id: v.id, overrideAccess: true })
    returned += v.weight ?? 0
  }
  return returned
}

/** The user's placed votes on an item: total, and how many are still locked (until when). */
export async function placedOn(payload: Payload, args: { item: string; user: string; scope?: string }) {
  const opts = optionsOf(payload)
  const stage = (await getItem(payload, args.item))?.stage
  const votes = await placedVotes(payload, args.user, args.scope, args.item)
  const locked = votes.filter((v) => unlocksAt(opts, v.createdAt, stage))
  return {
    votes: votes.reduce((n, v) => n + (v.weight ?? 0), 0),
    locked: locked.reduce((n, v) => n + (v.weight ?? 0), 0),
    lockedUntil: locked.map((v) => unlocksAt(opts, v.createdAt, stage)!).sort().at(-1) ?? null,
    released: releases(opts, stage),
  }
}

/**
 * Items in a release stage where the user still has placed votes they have not
 * chosen to keep: the voter is asked to move them (`withdrawVotes`) or keep
 * them (`keepVotes`).
 */
export async function releasedVotes(payload: Payload, args: { user: string; scope?: string }) {
  const opts = optionsOf(payload)
  if (!opts.allocation?.releaseStages?.length) return []
  const pending = (await placedVotes(payload, args.user, args.scope)).filter((v) => !(v as { kept?: boolean }).kept)
  if (!pending.length) return []
  const { docs } = await payload.find({
    collection: opts.slugs.items as CollectionSlug,
    where: { and: [{ id: { in: [...new Set(pending.map((v) => idOf(v.item)))] } }, { stage: { in: opts.allocation.releaseStages } }] },
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return (docs as unknown as RoadmapItemDoc[]).map((item) => ({
    item,
    votes: pending.filter((v) => idOf(v.item) === item.id).reduce((n, v) => n + (v.weight ?? 0), 0),
  }))
}

/** Keep placed votes on a released item (the voter's answer to `releasedVotes`). */
export async function keepVotes(payload: Payload, args: { item: string; user: string; scope?: string }) {
  const opts = optionsOf(payload)
  const votes = await placedVotes(payload, args.user, args.scope, args.item)
  for (const v of votes)
    await payload.update({
      collection: opts.slugs.votes as CollectionSlug,
      id: v.id,
      data: { kept: true } as never,
      overrideAccess: true,
    })
  return votes.reduce((n, v) => n + (v.weight ?? 0), 0)
}

/**
 * Combine `from` into `into` (similar requests): votes move over (a voter's
 * second free vote is dropped, placed votes keep their weight and date),
 * children move too, and `from` is hidden and points at `into`, so later
 * requests for it land on `into`.
 */
export async function mergeItems(payload: Payload, args: { from: string; into: string; req?: PayloadRequest }) {
  const opts = optionsOf(payload)
  const { req } = args
  if (args.from === args.into) throw new RoadmapError('An item can’t be merged into itself.')
  const find = async (where: Where) =>
    (
      await payload.find({
        collection: opts.slugs.votes as CollectionSlug,
        where,
        pagination: false,
        depth: 0,
        overrideAccess: true,
        req,
      })
    ).docs as unknown as VoteDoc[]
  const freeOnTarget = new Set(
    (await find({ and: [{ item: { equals: args.into } }, { ballot: { equals: FREE_BALLOT } }] })).map((v) => idOf(v.user)),
  )
  for (const v of await find({ item: { equals: args.from } })) {
    if (v.ballot === FREE_BALLOT && freeOnTarget.has(idOf(v.user))) {
      await payload.delete({ collection: opts.slugs.votes as CollectionSlug, id: v.id, overrideAccess: true, context: { roadmapInternal: true }, req })
      continue
    }
    await payload.update({
      collection: opts.slugs.votes as CollectionSlug,
      id: v.id,
      data: { item: args.into } as never,
      overrideAccess: true,
      req,
    })
  }
  await payload.update({
    collection: opts.slugs.items as CollectionSlug,
    where: { parent: { equals: args.from } },
    data: { parent: args.into } as never,
    overrideAccess: true,
    context: { roadmapInternal: true },
    req,
  })
  await payload.update({
    collection: opts.slugs.items as CollectionSlug,
    id: args.from,
    data: { hidden: true, mergedInto: args.into } as never,
    overrideAccess: true,
    context: { roadmapInternal: true },
    req,
  })
  await recountVotes(payload, args.from, req)
  return recountVotes(payload, args.into, req)
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
  // A merged item sends requests on to the one it was merged into.
  for (let hops = 0; item.mergedInto && hops < 5; hops++) {
    const next = await getItem(payload, idOf(item.mergedInto))
    if (!next) break
    item = next
  }
  const vote = args.user ? await castVote(payload, { item: item.id, user: args.user, note: args.note }) : null
  return { item, created, vote }
}
