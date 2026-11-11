import type { CollectionConfig, Config, Field, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { castVote, FREE_BALLOT, keepVotes, mergeItems, requestItem, roadmapPlugin, withdrawVotes, type ResolvedRoadmapOptions } from '../src'

// Made-up data only; Payload is replaced by a small in-memory fake.
const configure = (options: Parameters<typeof roadmapPlugin>[0] = {}) =>
  roadmapPlugin(options)({ collections: [] } as unknown as Config) as Config & { custom: { roadmap: ResolvedRoadmapOptions } }
const bySlug = (config: Config) => Object.fromEntries((config.collections ?? []).map((c) => [c.slug, c])) as Record<string, CollectionConfig>
const fieldOf = (c: CollectionConfig, name: string) =>
  c.fields.flatMap((f) => ('fields' in f && f.type === 'row' ? f.fields : [f])).find((f) => 'name' in f && f.name === name) as Field & {
    access?: Record<string, (a: unknown) => unknown>
    validate?: (v: unknown) => unknown
  }
const voter = { id: 'u1', collection: 'users' }

type Doc = Record<string, unknown> & { id: string }
/** In-memory Payload: equals, not_equals, in, exists and `and`; records deletes. */
const fakePayload = (config: Config, store: Record<string, Doc[]> = {}) => {
  let n = 0
  const get = (d: Doc, path: string) => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], d)
  const matches = (d: Doc, where: unknown): boolean => {
    if (!where) return true
    const w = where as Record<string, unknown>
    if (Array.isArray(w.and)) return w.and.every((x) => matches(d, x))
    return Object.entries(w).every(([path, cond]) => {
      const v = get(d, path)
      const c = cond as Record<string, unknown>
      if ('equals' in c) return v === c.equals
      if ('not_equals' in c) return v !== c.not_equals
      if ('in' in c) return (c.in as unknown[]).includes(v)
      if ('exists' in c) return (v != null) === c.exists
      return true
    })
  }
  const rows = (collection: string) => (store[collection] ??= [])
  const deleted: string[] = []
  const payload = {
    config,
    find: async ({ collection, where, limit }: { collection: string; where?: unknown; limit?: number }) => ({
      docs: rows(collection).filter((d) => matches(d, where)).slice(0, limit ?? Infinity),
    }),
    findByID: async ({ collection, id }: { collection: string; id: string }) => rows(collection).find((d) => d.id === id) ?? null,
    create: async ({ collection, data }: { collection: string; data: Record<string, unknown> }) => {
      const doc = { id: `${collection}-${++n}`, createdAt: new Date().toISOString(), ...data } as Doc
      rows(collection).push(doc)
      return doc
    },
    update: async ({ collection, id, where, data }: { collection: string; id?: string; where?: unknown; data: Record<string, unknown> }) => {
      for (const d of rows(collection).filter((d) => (id ? d.id === id : matches(d, where)))) Object.assign(d, data)
      return {}
    },
    delete: async ({ collection, id }: { collection: string; id: string }) => {
      deleted.push(id)
      store[collection] = rows(collection).filter((d) => d.id !== id)
    },
  }
  return { payload, store, deleted }
}

describe('access', () => {
  const { 'roadmap-items': items, 'roadmap-votes': votes } = bySlug(configure())
  const as = (user: object | null) => ({ req: { user } }) as never

  it('lets nobody create, update or delete items by default, signed in or not', async () => {
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(await items!.access![op]!(as(null))).toBe(false)
      expect(await items!.access![op]!(as(voter))).toBe(false)
    }
  })

  it('never lets anyone set vote totals directly', () => {
    for (const name of ['voteCount', 'voterCount']) {
      const f = fieldOf(items!, name)
      expect(f.access!.create!({} as never)).toBe(false)
      expect(f.access!.update!({} as never)).toBe(false)
    }
  })

  it('hides who requested an item from the public', () => {
    const f = fieldOf(items!, 'requestedBy')
    expect(f.access!.read!({ req: { user: null } } as never)).toBe(false)
    expect(f.access!.read!({ req: { user: voter } } as never)).toBe(true)
  })

  it('lets voters delete only their own votes, signed-out people none, and update none', async () => {
    expect(await votes!.access!.delete!(as(null))).toBe(false)
    expect(await votes!.access!.read!(as(null))).toBe(false)
    expect(await votes!.access!.delete!(as(voter))).toEqual({ user: { equals: 'u1' } })
    expect(await votes!.access!.update!(as(voter))).toBe(false)
  })

  it('lets curators see and remove every vote', async () => {
    const { 'roadmap-votes': managed } = bySlug(configure({ access: { manage: ({ req }) => Boolean(req.user?.id === 'curator') } }))
    expect(await managed!.access!.read!(as({ id: 'curator', collection: 'users' }))).toBe(true)
    expect(await managed!.access!.delete!(as({ id: 'curator', collection: 'users' }))).toBe(true)
  })

  it('shows the public only active notices, and only curators change them', async () => {
    const { 'roadmap-notices': notices } = bySlug(configure({ notices: { fields: [{ name: 'cites', label: 'CITES', options: [{ label: 'I', value: 'I' }] }] } }))
    expect(await notices!.access!.read!(as(null))).toEqual({ active: { equals: true } })
    expect(await notices!.access!.create!(as(voter))).toBe(false)
    expect(await notices!.access!.update!(as(voter))).toBe(false)
  })

  it('lets anyone read catalog categories, and only curators change them', async () => {
    const { 'roadmap-categories': categories } = bySlug(configure({ catalog: {} }))
    expect(await categories!.access!.read!(as(null))).toBe(true)
    expect(await categories!.access!.create!(as(voter))).toBe(false)
    expect(await categories!.access!.delete!(as(voter))).toBe(false)
  })

  it('accepts only site paths and https links in the catalog', () => {
    const items = bySlug(configure({ catalog: {} }))['roadmap-items']!
    const links = fieldOf(items, 'links') as unknown as { fields: { fields: { name: string; validate: (v: unknown) => unknown }[] }[] }
    const href = links.fields[0]!.fields.find((f) => f.name === 'href')!
    expect(href.validate('/climate')).toBe(true)
    expect(href.validate('https://example.com')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'climate']) expect(href.validate(bad)).not.toBe(true)
  })
})

describe('casting votes through the API', () => {
  const config = configure({ scopeField: 'tenant' })
  const hook = bySlug(config)['roadmap-votes']!.hooks!.beforeChange![0]!
  const run = (data: Record<string, unknown>, user: object | null, item: Doc | null) =>
    hook({ data, operation: 'create', req: { user, payload: { findByID: async () => item } } } as never)

  it('always votes as the signed-in voter, once, with weight one', async () => {
    const out = (await run({ item: 'i1', user: 'someone-else', ballot: 'placed:x', weight: 50 }, voter, { id: 'i1', tenant: 't1' })) as Record<string, unknown>
    expect(out).toMatchObject({ user: 'u1', ballot: FREE_BALLOT, weight: 1, tenant: 't1' })
  })

  it('refuses votes on hidden or missing items', async () => {
    await expect(run({ item: 'i1' }, voter, { id: 'i1', hidden: true })).rejects.toMatchObject({ status: 400 })
    await expect(run({ item: 'nope' }, voter, null)).rejects.toMatchObject({ status: 400 })
  })
})

describe('withdrawing placed votes through the API', () => {
  const config = configure({ allocation: { earned: async () => 10, lockDays: 30, releaseStages: ['declined'] } })
  const hook = bySlug(config)['roadmap-votes']!.hooks!.beforeDelete![0]!
  const run = (vote: object, user: object | null = voter) => hook({ id: 'v1', req: { user, payload: { findByID: async () => vote } } } as never)
  const now = new Date().toISOString()

  it('refuses while placed votes are locked, but not the free vote or released items', async () => {
    await expect(run({ ballot: 'placed:a', createdAt: now, item: { stage: 'planned' } })).rejects.toMatchObject({ status: 403 })
    await expect(run({ ballot: FREE_BALLOT, createdAt: now, item: { stage: 'planned' } })).resolves.toBeUndefined()
    await expect(run({ ballot: 'placed:a', createdAt: now, item: { stage: 'declined' } })).resolves.toBeUndefined()
    const old = new Date(Date.now() - 31 * 864e5).toISOString()
    await expect(run({ ballot: 'placed:a', createdAt: old, item: { stage: 'planned' } })).resolves.toBeUndefined()
  })

  it('withdrawVotes returns only unlocked votes; keepVotes marks them kept', async () => {
    const old = new Date(Date.now() - 31 * 864e5).toISOString()
    const { payload, store } = fakePayload(config, {
      'roadmap-items': [{ id: 'i1', stage: 'planned', board: 'features' }],
      'roadmap-votes': [
        { id: 'locked', item: 'i1', user: 'u1', ballot: 'placed:a', weight: 3, createdAt: now },
        { id: 'free-to-go', item: 'i1', user: 'u1', ballot: 'placed:b', weight: 2, createdAt: old },
        { id: 'other-user', item: 'i1', user: 'u2', ballot: 'placed:c', weight: 4, createdAt: old },
      ],
    })
    expect(await withdrawVotes(payload as never, { item: 'i1', user: 'u1' })).toBe(2)
    expect(store['roadmap-votes']!.map((v) => v.id)).toEqual(['locked', 'other-user'])
    expect(await keepVotes(payload as never, { item: 'i1', user: 'u1' })).toBe(3)
    expect(store['roadmap-votes']!.find((v) => v.id === 'locked')!.kept).toBe(true)
    expect(store['roadmap-votes']!.find((v) => v.id === 'other-user')!.kept).toBeUndefined()
  })
})

describe('merging', () => {
  const config = configure({ scopeField: 'tenant' })
  const hook = bySlug(config)['roadmap-items']!.hooks!.beforeChange![0]!
  const run = (originalDoc: Doc, mergedInto: string, into: Doc | null) =>
    hook({ data: { mergedInto }, originalDoc, operation: 'update', req: { payload: { findByID: async () => into } } } as never)
  const from = { id: 'a', title: 'A', slug: 'a', board: 'features', tenant: 't1' }

  it('refuses merging into itself, a merged item, another board or scope, a missing item, or merging twice', async () => {
    for (const into of [
      { ...from },
      { id: 'b', board: 'features', tenant: 't1', mergedInto: 'c' },
      { id: 'b', board: 'species', tenant: 't1' },
      { id: 'b', board: 'features', tenant: 't2' },
      null,
    ])
      await expect(run(from, into?.id ?? 'gone', into as Doc | null)).rejects.toMatchObject({ status: 400 })
    await expect(run({ ...from, mergedInto: 'x' }, 'b', { id: 'b', board: 'features', tenant: 't1' })).rejects.toThrow(/already merged/)
    await expect(run(from, 'b', { id: 'b', board: 'features', tenant: 't1' })).resolves.toMatchObject({ mergedInto: 'b' })
  })

  it('moves votes over, drops a second free vote, keeps placed votes, moves children and hides the old item', async () => {
    const { payload, store } = fakePayload(configure(), {
      'roadmap-items': [
        { id: 'a', board: 'features', stage: 'requested' },
        { id: 'b', board: 'features', stage: 'requested' },
        { id: 'child', board: 'features', parent: 'a' },
      ],
      'roadmap-votes': [
        { id: 'v1', item: 'a', user: 'u1', ballot: FREE_BALLOT, weight: 1 },
        { id: 'v2', item: 'a', user: 'u2', ballot: FREE_BALLOT, weight: 1 },
        { id: 'v3', item: 'a', user: 'u1', ballot: 'placed:x', weight: 5 },
        { id: 'v4', item: 'b', user: 'u1', ballot: FREE_BALLOT, weight: 1 },
      ],
    })
    expect(await mergeItems(payload as never, { from: 'a', into: 'b' })).toBe(7)
    const votes = Object.fromEntries(store['roadmap-votes']!.map((v) => [v.id, v.item]))
    expect(votes).toEqual({ v2: 'b', v3: 'b', v4: 'b' })
    const item = (id: string) => store['roadmap-items']!.find((i) => i.id === id)!
    expect(item('a')).toMatchObject({ hidden: true, mergedInto: 'b', voteCount: 0, voterCount: 0 })
    expect(item('b')).toMatchObject({ voteCount: 7, voterCount: 2 })
    expect(item('child').parent).toBe('b')
    await expect(mergeItems(payload as never, { from: 'b', into: 'b' })).rejects.toThrow(/itself/)
  })
})

describe('one item per subject, one free vote per person', () => {
  const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 })

  it('requests land on the existing item, following merges, with one vote per person', async () => {
    const { payload, store } = fakePayload(configure({ subject: { relationTo: 'taxa' } }), {
      'roadmap-items': [
        { id: 'old', board: 'species', key: 'subject:tx1', mergedInto: 'new' },
        { id: 'new', board: 'species', key: 'subject:tx2' },
      ],
    })
    const first = await requestItem(payload as never, { board: 'species', title: 'Any title', subject: 'tx1', user: 'u1' })
    expect(first).toMatchObject({ created: false, item: { id: 'new' }, vote: { created: true } })
    const again = await requestItem(payload as never, { board: 'species', title: 'Other title', subject: 'tx1', user: 'u1' })
    expect(again.vote!.created).toBe(false)
    expect(store['roadmap-votes']).toHaveLength(1)
    expect(store['roadmap-items']).toHaveLength(2)
  })

  it('resolves a concurrent duplicate vote to the existing one', async () => {
    const { payload, store } = fakePayload(configure())
    const create = payload.create
    payload.create = async (args) => {
      await create(args) // the other request won
      throw duplicate
    }
    const r = await castVote(payload as never, { item: 'i1', user: 'u1' })
    expect(r.created).toBe(false)
    expect(r.vote.id).toBe(store['roadmap-votes']![0]!.id)
  })
})

describe('release stages', () => {
  it('asks voters again when an item enters a release stage', async () => {
    const config = configure({ allocation: { earned: async () => 5, releaseStages: ['declined'] } })
    const after = bySlug(config)['roadmap-items']!.hooks!.afterChange![0]!
    const { payload, store } = fakePayload(config, { 'roadmap-votes': [{ id: 'v1', item: 'i1', user: 'u1', ballot: 'placed:a', weight: 2, kept: true }] })
    await after({ doc: { id: 'i1', stage: 'declined' }, previousDoc: { id: 'i1', stage: 'planned' }, operation: 'update', req: { payload } as unknown as PayloadRequest, context: {} } as never)
    expect(store['roadmap-votes']![0]!.kept).toBe(false)
  })
})

describe('docs hook', () => {
  it('logs only the error name when the docs plugin fails, never its message', async () => {
    const config = configure({ catalog: { docs: true } }) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    config.custom.docs = { onFeatureChange: async () => { throw new Error('made-up secret detail') } }
    const logs: unknown[] = []
    const payload = { config, logger: { error: (o: unknown) => void logs.push(o) }, findByID: async () => ({ id: 'c1', slug: 'c', title: 'C' }) }
    const hook = bySlug(config as never)['roadmap-items']!.hooks!.afterChange!.at(-1)!
    await hook({ doc: { id: 'a', board: 'features', title: 'x', stage: 'released', category: 'c1' }, req: { payload } } as never)
    expect(JSON.stringify(logs)).not.toContain('made-up secret detail')
    expect(logs).toHaveLength(1)
  })
})
