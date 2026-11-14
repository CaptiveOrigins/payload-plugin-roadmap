# payload-plugin-roadmap

A public roadmap with voting for [Payload](https://payloadcms.com) 3.

- **Items** move through stages that curators set (requested → under review → planned → in progress → released, or not planned). Votes inform priorities; they never change a stage by themselves.
- **One vote per user per item**, enforced by a unique index. The stored `voteCount` is recounted from the votes after every change, never incremented, so it cannot drift.
- **One item per subject.** Give items a subject (a taxon, a product, any collection) and a second request for the same subject finds the existing item instead of creating a duplicate.
- **Grouping.** Items can sit under a parent item. With `subject.parentOf`, items group automatically whichever is requested first (e.g. subspecies under their species).
- **Extra votes** (optional): on top of the one free vote per item, users can place votes they've earned (from gifts, points, a membership…) anywhere: several on one item or spread across many. Your app says how many each user has earned; placed votes are spent at once, can be locked for a set time, and rankings show people and votes separately.
- **Merging.** Editors combine similar items with "Merge into": votes move over (one free vote per person), children follow, and later requests for the old item land on the new one.
- **Release stages** (optional): a stage such as "not planned" frees placed votes at once; `releasedVotes` lists them so you can ask each voter to move them (`withdrawVotes`) or keep them (`keepVotes`).
- **Features catalog** (optional): a board's items double as a catalog of what your product does. Categories become its sections; each entry gets details, links and an audience, and is labeled from its stage (Available, Members, In progress, Planned). `getCatalog()` returns it ready to render, so the catalog never drifts from the roadmap.
- **Boards** keep separate roadmaps (e.g. features and species) in one pair of collections.
- **Scopes.** With `scopeField` (e.g. `tenant` from the multi-tenant plugin) each site has its own roadmap.

**Status: beta (0.x).** Used on a live site, where it was first built for a species roadmap. The API may still change before 1.0.

## On its own, and with others

**On its own.** Roadmap needs an auth collection whose accounts vote (`users` by default). Subjects, extra votes, notices and the catalog are optional, and each reads your own collections or functions, not another plugin.

**Works with:**

- **Docs** (`@extantape/payload-plugin-docs`): with `catalog: { docs: true }`, the catalog registers itself at `config.custom.docsSources` and calls Docs' `onFeatureChange` when an entry changes, so every feature gets a docs page. No import either way, and without Docs it does nothing. See [Features catalog](#features-catalog).
- **Membership** (`@extantape/payload-plugin-membership`): your `allocation.earned` function can count votes members have earned. There's no adapter for this. It's your own code.
- **Multi-tenant** (`@payloadcms/plugin-multi-tenant`): list `roadmap-items` and `roadmap-votes` in it and set `scopeField: 'tenant'`, and each site has its own roadmap.

**Family.** Roadmap is in the Patronage family, with Membership, Sponsors, Backing, Credits and Printify. Docs is in a different family (Library), so that pairing is "works with". The families are a working draft that may change.

## Install

```bash
npm install @extantape/payload-plugin-roadmap
```

```ts
import { roadmapPlugin } from '@extantape/payload-plugin-roadmap'

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
| `slugs` | `{ items: 'roadmap-items', votes: 'roadmap-votes', notices: 'roadmap-notices', categories: 'roadmap-categories' }` | Collection slugs |
| `usersSlug` | `'users'` | Auth collection whose accounts vote |
| `boards` | one board, `features` | Separate roadmaps |
| `stages` | requested, under-review, planned, in-progress, released, declined | First stage is where requests start |
| `subject` | none | `{ relationTo, filterOptions?, parentOf? }` |
| `scopeField` | none | Field that partitions roadmaps (not added by the plugin) |
| `access.manage` | nobody | Who edits items and sees every vote |
| `access.vote` | any signed-in user | Who may vote through the API. Only accounts of `usersSlug` can vote, always as themselves with weight 1; a vote that names another voter, a weight or a ballot is refused (403). Accounts from other auth collections never vote, see or delete votes unless `manage` lets them |
| `allocation` | off | `{ earned: ({ payload, user, scope }) => Promise<number>, lockDays?, boards?, releaseStages? }`: extra votes |
| `notices` | off | `{ fields: [{ name, label, options, boards? }] }`: conditional notices (below) |
| `catalog` | off | `{ boards?, availableStages?, progressStages?, hiddenStages? }`: features catalog (below) |
| `overrides.items` / `.votes` / `.notices` / `.categories` | | `(collection) => collection` |

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

### Features catalog

```ts
roadmapPlugin({ catalog: {} }) // board `features`; released = Available, in-progress = In progress
```

Adds a `roadmap-categories` collection (title, slug, summary, intro, order) and, on catalog
boards, `category`, `audience` (everyone or members), `order`, `details` and `links` to items.
Render it on a page:

```ts
import { getCatalog } from '@extantape/payload-plugin-roadmap'

const sections = await getCatalog(payload, { scope: tenantId, locale: 'de', fallbackLocale: 'en' })
// [{ slug, title, summary, intro, entries: [{ slug, title, summary, status, details, links, votes }] }]
```

Entries without a category, hidden items and "not planned" items are left out. Members
suggest new entries through the board as usual; once an editor gives one a category it appears
in the catalog as Planned.

**Docs for every entry.** With `catalog: { docs: true }` (or `{ docs: { name } }`), the catalog
feeds a docs plugin such as `@extantape/payload-plugin-docs`, with no import either way:

- it registers itself at `config.custom.docsSources`, so the docs plugin's nightly sync reads every visible entry;
- after an entry changes, it calls the docs plugin's `onFeatureChange` when that's there, so the page follows: made, marked out of date, or archived when the entry is hidden, declined, merged or deleted.

Without the docs plugin it does nothing. A failure there never fails the edit: it's logged, and
the nightly sync catches up. Only the public catalog's words go across (title, summary, details,
site-path links, stage and section). The catalog isn't split by site for docs.


## Server helpers

For server actions and endpoints that have already checked the user and scope (they run with `overrideAccess`):

```ts
import { castVote, removeVote, requestItem, recountVotes } from '@extantape/payload-plugin-roadmap'

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

Each placement of extra votes takes the voter's next numbered slot, stored in the votes' `slot` field under a unique index. Of two placements that read the same balance, only one saves; the other reads again and either places on what's left or is refused. After saving, the balance is checked once more, and a placement that would overspend is undone. On MongoDB the index is `{ slot: 1 }`, unique and sparse (Payload builds it with `ensureIndexes`; a site that builds indexes by hand needs `db['<votes slug>'].createIndex({ slot: 1 }, { unique: true, sparse: true })`). Sparse skips votes with no `slot` but not a stored `null`, so the plugin never stores a null or empty slot. On Postgres or SQLite, the new `slot` column needs a migration.

## License

MIT
