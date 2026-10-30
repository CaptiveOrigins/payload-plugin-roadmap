import type { CollectionConfig, Config, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { allocateVotes, itemKey, recountVotes, roadmapPlugin, slugify, unlocksAt, voteBalance, type ResolvedRoadmapOptions } from '../src'

const configure = (options: Parameters<typeof roadmapPlugin>[0] = {}) =>
  roadmapPlugin(options)({ collections: [] } as unknown as Config) as Config & { custom: { roadmap: ResolvedRoadmapOptions } }
const bySlug = (config: Config) => Object.fromEntries((config.collections ?? []).map((c) => [c.slug, c])) as Record<string, CollectionConfig>
const req = (user?: object) => ({ user: user ?? null }) as unknown as PayloadRequest

describe('config', () => {
  it('adds items and votes with one vote per user per item and one item per subject per board', () => {
    const config = configure({ subject: { relationTo: 'taxa' }, scopeField: 'tenant' })
    const { 'roadmap-items': items, 'roadmap-votes': votes } = bySlug(config)
    expect(items!.indexes).toEqual([{ fields: ['tenant', 'board', 'key'], unique: true }])
    expect(votes!.indexes).toEqual([{ fields: ['item', 'user', 'ballot'], unique: true }])
    const names = items!.fields.flatMap((f) => ('fields' in f && f.type === 'row' ? f.fields : [f])).map((f) => ('name' in f ? f.name : null))
    expect(names).toEqual(expect.arrayContaining(['title', 'board', 'stage', 'subject', 'parent', 'voteCount', 'hidden', 'votes']))
    expect(config.custom.roadmap.stages[0]!.value).toBe('requested')
  })

  it('denies management by default, lets signed-in users vote, and shows the public only visible items', async () => {
    const { 'roadmap-items': items, 'roadmap-votes': votes } = bySlug(configure())
    expect(await items!.access!.update!({ req: req({ id: 'u1' }) } as never)).toBe(false)
    expect(await items!.access!.read!({ req: req() } as never)).toEqual({ hidden: { not_equals: true } })
    expect(await votes!.access!.create!({ req: req() } as never)).toBe(false)
    expect(await votes!.access!.create!({ req: req({ id: 'u1' }) } as never)).toBe(true)
    expect(await votes!.access!.read!({ req: req({ id: 'u1' }) } as never)).toEqual({ user: { equals: 'u1' } })
  })

  it('applies overrides', () => {
    const config = configure({ overrides: { items: (c) => ({ ...c, admin: { ...c.admin, group: 'Plans' } }) } })
    expect(bySlug(config)['roadmap-items']!.admin!.group).toBe('Plans')
  })
})

describe('helpers', () => {
  it('derives slugs and keys', () => {
    expect(slugify('Testudo graeca ibera')).toBe('testudo-graeca-ibera')
    expect(itemKey('t1', 'x')).toBe('subject:t1')
    expect(itemKey(null, 'dark-mode')).toBe('slug:dark-mode')
  })

  it('sets votes (by weight) and people from the votes, not by incrementing', async () => {
    const updates: unknown[] = []
    const payload = {
      config: configure(),
      find: async () => ({ docs: [{ user: 'a', weight: 1 }, { user: 'a', weight: 10 }, { user: 'b', weight: 1 }] }),
      update: async (args: unknown) => updates.push(args),
    }
    expect(await recountVotes(payload as never, 'i1')).toBe(12)
    expect(updates[0]).toMatchObject({ collection: 'roadmap-items', id: 'i1', data: { voteCount: 12, voterCount: 2 } })
  })

  it('spends placed votes from the earned balance and refuses overspending', async () => {
    const placed: { weight: number }[] = [{ weight: 2 }]
    const created: unknown[] = []
    const payload = {
      config: configure({ allocation: { earned: async () => 3.5 } }),
      findByID: async () => ({ id: 'i', board: 'features', stage: 'requested' }),
      find: async () => ({ docs: placed }),
      create: async (args: { data: { weight: number } }) => {
        created.push(args.data)
        placed.push({ weight: args.data.weight })
        return { id: 'v' }
      },
      delete: async () => placed.pop(),
    }
    expect(await voteBalance(payload as never, { user: 'u' })).toEqual({ earned: 3, spent: 2, available: 1 })
    await expect(allocateVotes(payload as never, { item: 'i', user: 'u', votes: 2 })).rejects.toThrow(/that many votes/)
    await allocateVotes(payload as never, { item: 'i', user: 'u', votes: 1 })
    expect(created).toEqual([expect.objectContaining({ weight: 1, item: 'i', user: 'u' })])
    expect(await voteBalance(payload as never, { user: 'u' })).toEqual({ earned: 3, spent: 3, available: 0 })
  })

  it('limits extra votes to some boards and releases them on some stages', async () => {
    const config = configure({ allocation: { earned: async () => 5, lockDays: 183, boards: ['species'], releaseStages: ['declined'] } })
    const payload = (item: object) => ({ config, findByID: async () => item, find: async () => ({ docs: [] }) })
    await expect(
      allocateVotes(payload({ id: 'i', board: 'features', stage: 'requested' }) as never, { item: 'i', user: 'u', votes: 1 }),
    ).rejects.toThrow(/can’t be placed/)
    await expect(
      allocateVotes(payload({ id: 'i', board: 'species', stage: 'declined' }) as never, { item: 'i', user: 'u', votes: 1 }),
    ).rejects.toThrow(/not planned/)
    const now = new Date().toISOString()
    expect(unlocksAt(config.custom.roadmap, now, 'planned')).not.toBeNull()
    expect(unlocksAt(config.custom.roadmap, now, 'declined')).toBeNull()
  })

  it('adds merge and keep fields', () => {
    const { 'roadmap-items': items, 'roadmap-votes': votes } = bySlug(configure())
    expect(items!.fields.some((f) => 'name' in f && f.name === 'mergedInto')).toBe(true)
    expect(votes!.fields.some((f) => 'name' in f && f.name === 'kept')).toBe(true)
  })
})
