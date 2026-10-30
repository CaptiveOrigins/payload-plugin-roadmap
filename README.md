# payload-plugin-roadmap

A public roadmap with voting for [Payload](https://payloadcms.com) 3.

- **Items** move through stages that curators set (requested → under review → planned → in progress → released, or not planned). Votes inform priorities; they never change a stage by themselves.
- **One vote per user per item**, enforced by a unique index. The stored `voteCount` is recounted from the votes after every change, never incremented, so it cannot drift.
- **One item per subject.** Give items a subject (a taxon, a product, any collection) and a second request for the same subject finds the existing item instead of creating a duplicate.
- **Grouping.** Items can sit under a parent item. With `subject.parentOf`, items group automatically whichever is requested first (e.g. subspecies under their species).
- **Extra votes** (optional): on top of the one free vote per item, users can place votes they've earned (from gifts, points, a membership…) anywhere: several on one item or spread across many. Your app says how many each user has earned; placed votes are spent at once, can be locked for a set time, and rankings show people and votes separately.
- **Boards** keep separate roadmaps (e.g. features and species) in one pair of collections.
- **Scopes.** With `scopeField` (e.g. `tenant` from the multi-tenant plugin) each site has its own roadmap.

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
| `slugs` | `{ items: 'roadmap-items', votes: 'roadmap-votes' }` | Collection slugs |
| `usersSlug` | `'users'` | Auth collection whose accounts vote |
| `boards` | one board, `features` | Separate roadmaps |
| `stages` | requested, under-review, planned, in-progress, released, declined | First stage is where requests start |
| `subject` | none | `{ relationTo, filterOptions?, parentOf? }` |
| `scopeField` | none | Field that partitions roadmaps (not added by the plugin) |
| `access.manage` | nobody | Who edits items and sees every vote |
| `access.vote` | any signed-in user | Who may vote through the API (always as themselves) |
| `allocation` | off | `{ earned: ({ payload, user, scope }) => Promise<number>, lockDays? }`: extra votes |
| `overrides.items` / `overrides.votes` | | `(collection) => collection` |

The public reads items that are not `hidden`. Voters read and delete only their own votes.

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
```

Votes and new items are inserted outside a transaction so that concurrent duplicates fail cleanly on the unique index and resolve to the existing record.

## License

MIT
