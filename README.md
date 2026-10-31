# payload-plugin-roadmap

A public roadmap with voting for [Payload](https://payloadcms.com) 3.

- **Items** move through stages that curators set (requested → under review → planned → in progress → released, or not planned). Votes inform priorities; they never change a stage by themselves.
- **One vote per user per item**, enforced by a unique index. The stored `voteCount` is recounted from the votes after every change, never incremented, so it cannot drift.
- **One item per subject.** Give items a subject (a taxon, a product, any collection) and a second request for the same subject finds the existing item instead of creating a duplicate.
- **Grouping.** Items can sit under a parent item. With `subject.parentOf`, items group automatically whichever is requested first (e.g. subspecies under their species).
- **Extra votes** (optional): on top of the one free vote per item, users can place votes they've earned (from gifts, points, a membership…) anywhere: several on one item or spread across many. Your app says how many each user has earned; placed votes are spent at once, can be locked for a set time, and rankings show people and votes separately.
- **Merging.** Editors combine similar items with "Merge into": votes move over (one free vote per person), children follow, and later requests for the old item land on the new one.
- **Release stages** (optional): a stage such as "not planned" frees placed votes at once; `releasedVotes` lists them so you can ask each voter to move them (`withdrawVotes`) or keep them (`keepVotes`).
- **Boards** keep separate roadmaps (e.g. features and species) in one pair of collections.
- **Scopes.** With `scopeField` (e.g. `tenant` from the multi-tenant plugin) each site has its own roadmap.

**Status: beta (0.x).** Used by [Captive Origins](https://captiveorigins.com); the API may still change before 1.0.

Built for [Captive Origins](https://captiveorigins.com)'s Species Roadmap.

## Install

```bash
npm install payload-plugin-roadmap
```

```ts
import { roadmapPlugin } from 'payload-plugin-roadmap'

export default buildConfig({
  plugins: [
    roadmapPlugin({
      boards: [
        { label: 'Features', value: 'features' },
        { label: 'Species', value: 'species' },
      ],
      subject: {
        relationTo: 'taxa',
        filterOptions: { rank: { in: ['species', 'subspecies'] } },
        // Optional: group a subspecies under its species' item.
        parentOf: async ({ id, req }) => {
          const t = await req.payload.findByID({ collection: 'taxa', id, depth: 0, req })
          return t.rank === 'subspecies' ? (t.parent as string) : null
        },
      },
      access: {
        manage: ({ req }) => Boolean(req.user?.roles?.includes('admin')), // curators
        vote: ({ req }) => Boolean(req.user), // REST/GraphQL voting; () => false for server-only voting
      },
    }),
  ],
})
```

Add the plugin before plugins that wrap collections it creates (e.g. list `roadmap-items` and `roadmap-votes` in the multi-tenant plugin, and set `scopeField: 'tenant'`).

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `{ items: 'roadmap-items', votes: 'roadmap-votes', notices: 'roadmap-notices' }` | Collection slugs |
| `usersSlug` | `'users'` | Auth collection whose accounts vote |
| `boards` | one board, `features` | Separate roadmaps |
| `stages` | requested, under-review, planned, in-progress, released, declined | First stage is where requests start |
| `subject` | none | `{ relationTo, filterOptions?, parentOf? }` |
| `scopeField` | none | Field that partitions roadmaps (not added by the plugin) |
| `access.manage` | nobody | Who edits items and sees every vote |
| `access.vote` | any signed-in user | Who may vote through the API (always as themselves) |
| `allocation` | off | `{ earned: ({ payload, user, scope }) => Promise<number>, lockDays?, boards?, releaseStages? }`: extra votes |
| `notices` | off | `{ fields: [{ name, label, options, boards? }] }`: conditional notices (below) |
| `overrides.items` / `.votes` / `.notices` | | `(collection) => collection` |

The public reads items that are not `hidden`. Voters read and delete only their own votes.

### Conditional notices

Declare facts about items that editors can match on, and the plugin adds a `roadmap-notices`
collection: each rule ticks values (any match counts), has a message, and can ask voters to
confirm before voting or requesting. Your app computes each entry's values, so a rule can also
apply to a subject that has no item yet:

```ts
roadmapPlugin({
  notices: { fields: [{ name: 'cites', label: 'CITES Appendix', boards: ['species'], options: [{ label: 'I', value: 'I' }] }] },
})

const rules = await getNoticeRules(payload, { board: 'species', scope: tenantId })
const notices = matchingNotices(rules, { cites: taxon.citesAppendices })  // [{ id, message, confirm }]
```

Without fields there is no notices collection.

## Server helpers

For server actions and endpoints that have already checked the user and scope (they run with `overrideAccess`):

```ts
import { castVote, removeVote, requestItem, recountVotes } from 'payload-plugin-roadmap'

await requestItem(payload, { board: 'species', title: 'Testudo graeca', subject: taxonId, scope: tenantId, user: userId })
await castVote(payload, { item, user })   // returns the existing vote if there is one
await removeVote(payload, { item, user })
await allocateVotes(payload, { item, user, votes: 10, scope })  // spends from the balance
await voteBalance(payload, { user, scope })                      // { earned, spent, available }
await withdrawVotes(payload, { item, user, scope })              // unlocked placed votes back to the balance
await releasedVotes(payload, { user, scope })                    // placed votes on items in a release stage, not yet kept
await keepVotes(payload, { item, user, scope })                  // the voter keeps them there
await mergeItems(payload, { from, into })                        // same as setting "Merge into" in the admin
```

Votes and new items are inserted outside a transaction so that concurrent duplicates fail cleanly on the unique index and resolve to the existing record.

## License

MIT
