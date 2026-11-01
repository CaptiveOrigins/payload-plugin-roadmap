import type { CollectionConfig, Config, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { allocateVotes, itemKey, matchingNotices, recountVotes, roadmapPlugin, slugify, unlocksAt, voteBalance, type NoticeRule, type ResolvedRoadmapOptions } from '../src'

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

describe('notices', () => {
  const fields = [{ name: 'cites', label: 'CITES', boards: ['species'], options: [{ label: 'I', value: 'I' }, { label: 'II', value: 'II' }] }]
  const collectionsOf = (notices?: { fields: typeof fields }) =>
    (configure({ notices }).collections ?? []).map((c) => c.slug)

  it('adds a notices collection only when fields are configured', () => {
    expect(collectionsOf()).toEqual(['roadmap-items', 'roadmap-votes'])
    expect(collectionsOf({ fields })).toEqual(['roadmap-items', 'roadmap-votes', 'roadmap-notices'])
  })

  it('matches rules whose ticked values meet the entry’s values', () => {
    const rules: NoticeRule[] = [
      { id: 'a', message: 'Protected', confirm: true, when: { cites: ['I'] } },
      { id: 'b', message: 'Trade permits', confirm: false, when: { cites: ['II'] } },
    ]
    expect(matchingNotices(rules, { cites: ['I', 'II'] }).map((n) => n.id)).toEqual(['a', 'b'])
    expect(matchingNotices(rules, { cites: ['II'] })).toEqual([{ id: 'b', message: 'Trade permits', confirm: false }])
    expect(matchingNotices(rules, {})).toEqual([])
  })
})

describe('catalog', () => {
  it('adds categories and catalog fields only when enabled, and labels entries from their stage', async () => {
    expect(bySlug(configure())['roadmap-categories']).toBeUndefined()
    const config = configure({ catalog: {}, slugs: { categories: 'feature-categories' } })
    const { 'feature-categories': categories, 'roadmap-items': items } = bySlug(config)
    expect(categories!.indexes).toEqual([{ fields: ['slug'], unique: true }])
    const names = items!.fields.map((f) => ('name' in f ? f.name : null))
    expect(names).toEqual(expect.arrayContaining(['category', 'audience', 'order', 'details', 'links']))
    const { catalogStatus } = await import('../src')
    const opts = config.custom.roadmap
    expect(['released', 'in-progress', 'planned', 'requested', 'declined'].map((s) => catalogStatus(opts, s))).toEqual(['available', 'in-progress', 'planned', 'planned', null])
    expect(catalogStatus(opts, 'released', 'members')).toBe('members')
  })

  it('groups visible entries by category, in order', async () => {
    const { getCatalog } = await import('../src')
    const calls: { collection: string; where: unknown }[] = []
    const payload = {
      config: configure({ catalog: {}, scopeField: 'tenant' }),
      find: async (args: { collection: string; where: unknown }) => {
        calls.push(args)
        return args.collection === 'roadmap-categories'
          ? { docs: [{ id: 'c1', slug: 'climate', title: 'Climate' }, { id: 'c2', slug: 'empty', title: 'Empty' }] }
          : {
              docs: [
                { id: 'a', slug: 'score', title: 'Score', stage: 'released', category: 'c1', details: [{ text: 'd' }], voteCount: 2 },
                { id: 'b', slug: 'gone', title: 'Gone', stage: 'declined', category: 'c1' },
                { id: 'c', slug: 'indoor', title: 'Indoor', stage: 'planned', category: { id: 'c1' } },
              ],
            }
      },
    }
    const sections = await getCatalog(payload as never, { scope: 't1' })
    expect(sections.map((s) => [s.slug, s.entries.map((e) => `${e.slug}:${e.status}`)])).toEqual([
      ['climate', ['score:available', 'indoor:planned']],
      ['empty', []],
    ])
    expect(JSON.stringify(calls[1]!.where)).toContain('"tenant":{"equals":"t1"}')
  })
})
