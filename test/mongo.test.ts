import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { allocateVotes, castVote, mergeItems, requestItem, roadmapPlugin } from '../src/index.js'

// The votes' unique `slot` index on a real MongoDB (in memory, a replica set as on a site).
// Made-up example.com people and items only.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const DB = 'roadmap-mongo'
const LEGACY = 60
const PASSWORD = 'a-made-up-test-password'

let mongo: MongoMemoryReplSet
let client: MongoClient
let payload: Payload
let earned = 4
const votes = () => client.db(DB).collection('roadmap-votes')

let curator: Doc, voters: Doc[]
let itemA: string, itemB: string

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  client = await MongoClient.connect(mongo.getUri())
  // A site that already has many votes from before `slot` existed: none has the field.
  const legacyItem = new ObjectId()
  await votes().insertMany(
    Array.from({ length: LEGACY }, (_, i) => ({
      item: legacyItem,
      user: new ObjectId(),
      ballot: i % 2 ? 'free' : `placed:legacy:${i}`,
      weight: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  )
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(DB), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] }],
      plugins: [
        roadmapPlugin({
          allocation: { earned: async () => earned },
          access: { manage: ({ req }) => (req.user as Doc | null)?.role === 'curator' },
        }),
      ],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.ensureIndexes()
  const user = (email: string, role = 'voter') => payload.create({ collection: 'users', data: { email, password: PASSWORD, role } as never }) as Promise<Doc>
  curator = await user('curator@example.com', 'curator')
  voters = await Promise.all(['v1', 'v2', 'v3', 'v4'].map((v) => user(`${v}@example.com`)))
  itemA = String((await requestItem(payload, { board: 'features', title: 'Made-up feature A' })).item.id)
  itemB = String((await requestItem(payload, { board: 'features', title: 'Made-up feature B' })).item.id)
}, 180_000)

afterAll(async () => {
  await client?.close()
  await payload?.destroy()
  await mongo?.stop()
})

/** Votes whose stored `slot` is null, empty, or anything else but an absent field or a non-empty string. */
const badSlots = () => votes().countDocuments({ $or: [{ slot: { $exists: true, $not: { $type: 'string' } } }, { slot: '' }] })

describe('the slot index on real MongoDB', () => {
  it('builds unique and sparse on a collection that already has many votes without a slot', async () => {
    const index = (await votes().indexes()).find((i) => Object.keys(i.key).join() === 'slot')
    expect(index).toMatchObject({ key: { slot: 1 }, unique: true, sparse: true })
    expect(await votes().countDocuments({ slot: { $exists: false } })).toBeGreaterThanOrEqual(LEGACY)
  })

  it('never writes a null or shared slot: curator votes, free votes, server placements, edits and merges', async () => {
    const [v1, v2] = voters as [Doc, Doc]
    // Curators, through the Local API as themselves (two, so a shared value would collide).
    for (const voter of [v1, v2])
      await payload.create({ collection: 'roadmap-votes' as never, data: { item: itemA, user: voter.id, note: 'Made-up reason' } as never, user: curator as never, overrideAccess: false })
    // A voter's own free vote, through the access-checked path.
    await payload.create({ collection: 'roadmap-votes' as never, data: { item: itemB } as never, user: { ...v1, collection: 'users' } as never, overrideAccess: false })
    // The plugin's server paths: free votes and placements.
    await castVote(payload, { item: itemB, user: String(v2.id) })
    earned = 4
    await allocateVotes(payload, { item: itemA, user: String(v1.id), votes: 1 })
    await allocateVotes(payload, { item: itemB, user: String(v1.id), votes: 1 })
    // Edits to existing votes, by a curator and on the server.
    const all = (await payload.find({ collection: 'roadmap-votes' as never, where: { item: { in: [itemA, itemB] } }, pagination: false, depth: 0 })).docs as Doc[]
    for (const v of all) await payload.update({ collection: 'roadmap-votes' as never, id: v.id, data: { note: 'Edited, made-up' } as never, user: curator as never, overrideAccess: false })
    for (const v of all) await payload.update({ collection: 'roadmap-votes' as never, id: v.id, data: { kept: true } as never, overrideAccess: true })
    // A legacy vote with no slot, edited.
    const legacy = await votes().findOne({ slot: { $exists: false }, ballot: 'free' })
    await payload.update({ collection: 'roadmap-votes' as never, id: String(legacy!._id), data: { note: 'Edited legacy' } as never, overrideAccess: true })
    // A merge moves every vote on B onto A.
    await mergeItems(payload, { from: itemB, into: itemA })

    expect(await badSlots()).toBe(0)
    const slots = (await votes().find({ slot: { $type: 'string' } }).toArray()).map((v) => v.slot as string)
    expect(slots.sort()).toEqual([`${v1.id}::1`, `${v1.id}::2`])
    expect(await votes().countDocuments({ slot: { $exists: false } })).toBeGreaterThan(LEGACY)
  })

  it('stores no slot when server code or a curator sends a null or empty slot, on create or edit', async () => {
    const [, , v3, v4] = voters as [Doc, Doc, Doc, Doc]
    const made: Doc[] = []
    for (const [voter, slot] of [[v3, null], [v4, '']] as const)
      made.push(await payload.create({ collection: 'roadmap-votes' as never, data: { item: itemA, user: voter.id, slot } as never, overrideAccess: true }) as Doc)
    const itemC = String((await requestItem(payload, { board: 'features', title: 'Made-up feature C' })).item.id)
    made.push(await payload.create({ collection: 'roadmap-votes' as never, data: { item: itemC, user: v3.id, slot: null } as never, user: curator as never, overrideAccess: false }) as Doc)
    for (const v of made) await payload.update({ collection: 'roadmap-votes' as never, id: v.id, data: { slot: null } as never, overrideAccess: true })
    expect(await badSlots()).toBe(0)
    for (const v of made) await payload.delete({ collection: 'roadmap-votes' as never, id: v.id, overrideAccess: true })
  })

  it('lets exactly one of two colliding placements save, on the real index', async () => {
    const v3 = String(voters[2]!.id)
    earned = 2
    // Both placements read the balance before either saves: hold the first two reads at a barrier.
    let arrived = 0
    let open!: () => void
    const both = new Promise<void>((r) => (open = r))
    const gated = Object.create(payload) as Payload
    gated.find = (async (args: Parameters<Payload['find']>[0]) => {
      const result = await payload.find(args)
      if (args.collection === 'roadmap-votes' && arrived < 2) {
        if (++arrived === 2) open()
        await both
      }
      return result
    }) as Payload['find']
    const results = await Promise.allSettled([
      allocateVotes(gated, { item: itemA, user: v3, votes: 2 }),
      allocateVotes(gated, { item: itemA, user: v3, votes: 2 }),
    ])
    expect(arrived).toBe(2)
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { message: 'You don’t have that many votes available.' } })
    const placed = await votes().find({ slot: { $regex: `^${v3}:` } }).toArray()
    expect(placed.map((v) => [v.slot, v.weight])).toEqual([[`${v3}::1`, 2]])
  })
})

// Catalog categories on real MongoDB: one unique slug index, global without a scopeField and per scope with one.
// Each site is its own Payload on its own database. Made-up categories only.
describe('the catalog category slug index on real MongoDB', () => {
  const sites: Payload[] = []
  const categories = (db: string) => client.db(db).collection('roadmap-categories')
  /** Every index on categories that covers `slug`, as name, key and uniqueness, sorted by name. */
  const slugIndexes = async (db: string) =>
    (await categories(db).indexes())
      .filter((i) => 'slug' in i.key)
      .map((i) => ({ name: i.name, key: i.key, unique: i.unique === true }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))

  /** Starts a site with the catalog on, building every index the way a site's start does. */
  const startSite = async (db: string, scopeField?: string) => {
    // The plugin leaves the scope field to the host: add it to the roadmap's collections.
    const addScope = (config: Parameters<NonNullable<Parameters<typeof buildConfig>[0]['plugins']>[number]>[0]) =>
      scopeField
        ? {
            ...config,
            collections: (config.collections ?? []).map((c) =>
              c.slug.startsWith('roadmap-') ? { ...c, fields: [...c.fields, { name: scopeField, type: 'text' as const }] } : c,
            ),
          }
        : config
    const site = await getPayload({
      key: db,
      config: await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url: mongo.getUri(db), ensureIndexes: true }),
        collections: [{ slug: 'users', auth: true, fields: [] }],
        plugins: [roadmapPlugin({ catalog: {}, ...(scopeField ? { scopeField } : {}) }), addScope],
      }),
    })
    sites.push(site)
    const models = (site.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<unknown> }> }).collections
    for (const m of Object.values(models)) await m.ensureIndexes()
    return site
  }
  /** Payload's refusal when the unique index rejects a save (it names the index's first field). */
  const notUnique = { name: 'ValidationError', data: { errors: [{ message: 'Value must be unique' }] } }
  const category = (site: Payload, data: Doc) => site.create({ collection: 'roadmap-categories' as never, data: data as never, overrideAccess: true }) as Promise<Doc>

  afterAll(async () => {
    for (const site of sites) await site.destroy()
  })

  it('starts without a scopeField, with one unique slug index, and refuses a duplicate slug', async () => {
    const db = 'roadmap-catalog-global'
    const site = await startSite(db)
    expect(await slugIndexes(db)).toEqual([{ name: 'slug_1', key: { slug: 1 }, unique: true }])
    await category(site, { title: 'Made-up climate tools', slug: 'climate' })
    await expect(category(site, { title: 'Another made-up section', slug: 'climate' })).rejects.toMatchObject(notUnique)
    // A slug made from the title collides too.
    await category(site, { title: 'Made-up Habitat' })
    await expect(category(site, { title: 'Made-up Habitat' })).rejects.toMatchObject(notUnique)
    expect(await categories(db).countDocuments({ slug: 'climate' })).toBe(1)
    expect(await categories(db).countDocuments({ slug: 'made-up-habitat' })).toBe(1)
  }, 120_000)

  it('with a scopeField, allows one slug in two scopes and refuses a duplicate within a scope', async () => {
    const db = 'roadmap-catalog-scoped'
    const site = await startSite(db, 'tenant')
    // Unchanged from 0.4.1, so a scoped site needs no index migration.
    expect(await slugIndexes(db)).toEqual([
      { name: 'slug_1', key: { slug: 1 }, unique: false },
      { name: 'tenant_1_slug_1', key: { tenant: 1, slug: 1 }, unique: true },
    ])
    await category(site, { title: 'Made-up climate tools', slug: 'climate', tenant: 'site-a' })
    await category(site, { title: 'Made-up climate tools', slug: 'climate', tenant: 'site-b' })
    await expect(category(site, { title: 'Another made-up section', slug: 'climate', tenant: 'site-a' })).rejects.toMatchObject(notUnique)
    expect(await categories(db).countDocuments({ slug: 'climate' })).toBe(2)
    expect(await categories(db).countDocuments({ slug: 'climate', tenant: 'site-a' })).toBe(1)
  }, 120_000)
})
