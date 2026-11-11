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
