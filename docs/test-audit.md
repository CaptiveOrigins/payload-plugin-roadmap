# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

## 2026-11-10: first audit

Suite before: 16 tests in 1 file. After: 34 tests in 2 files. All tests use made-up data and a small in-memory fake of Payload; none use a database.

### Promises and the tests that prove them

| Promise (README, code docs) | Test |
| --- | --- |
| One vote per user per item, one item per subject per board (unique indexes) | `plugin.test.ts` "adds items and votes…" |
| `voteCount` recounted from the votes, never incremented | `plugin.test.ts` "sets votes (by weight) and people from the votes…" |
| Nobody sets vote totals directly | `access-and-votes.test.ts` "never lets anyone set vote totals directly" (added) |
| `access.manage` defaults to nobody: items can't be created, changed or deleted | "lets nobody create, update or delete items…" (added); `plugin.test.ts` "denies management by default…" |
| The public reads only items that aren't hidden | `plugin.test.ts` "denies management by default…" |
| Who requested an item isn't shown to the public | "hides who requested an item from the public" (added) |
| Voters read and delete only their own votes; signed-out people neither; nobody but curators updates | `plugin.test.ts` (read); "lets voters delete only their own votes…" (added) |
| Curators see and remove every vote | "lets curators see and remove every vote" (added) |
| API voters always vote as themselves, with one free vote of weight 1 | "always votes as the signed-in voter…" (added) |
| No votes on hidden or missing items | "refuses votes on hidden or missing items" (added) |
| Placed votes can't be withdrawn through the API while locked; free votes and released items can | "refuses while placed votes are locked…" (added) |
| `withdrawVotes` returns only unlocked votes; `keepVotes` keeps them | "withdrawVotes returns only unlocked votes…" (added) |
| Extra votes: spent from the balance, never overspent, board limits, release stages | `plugin.test.ts` "spends placed votes…", "limits extra votes…", "lets one of two colliding placements through…" |
| Entering a release stage asks voters again (`kept` cleared) | "asks voters again when an item enters a release stage" (added) |
| Merge refuses itself, merged targets, other boards or scopes, missing items, merging twice | "refuses merging into itself…" (added) |
| Merge moves votes (one free vote per person), keeps placed votes, moves children, hides the old item | "moves votes over, drops a second free vote…" (added) |
| A second request for the same subject finds the existing item, following merges | "requests land on the existing item…" (added) |
| Concurrent duplicate votes resolve to the existing one | "resolves a concurrent duplicate vote…" (added) |
| Notices: public sees only active rules; only curators change them; matching | "shows the public only active notices…" (added); `plugin.test.ts` "notices" |
| Catalog: categories public, curators edit; labels from stage; hidden and declined left out; scope and locale | "lets anyone read catalog categories…" (added); `plugin.test.ts` "catalog" |
| Catalog links are only site paths or https (no `javascript:`) | "accepts only site paths and https links…" (added) |
| Docs feed: off unless asked; only public words and site-path links go across; a docs failure never fails the edit | `plugin.test.ts` "docs feature source" |
| A docs failure is logged without its message | "logs only the error name…" (added) |
| Overrides apply | `plugin.test.ts` "applies overrides" |

### Gaps added

- Access refusals: items, vote totals, `requestedBy`, votes (read, delete, update), notices, categories.
- API voting: forced voter, free ballot and weight; hidden and missing items refused.
- Locked placed votes can't be withdrawn early; `withdrawVotes` and `keepVotes`.
- Merge refusals and the merge itself.
- One item per subject (including after a merge) and duplicate-vote handling.
- Release stages clearing `kept`.
- Catalog link validation, and the docs hook not logging error messages.

### Gaps skipped

- `slugify`, `itemKey`, `idOf`: covered by the helper tests or trivial.
- Automatic grouping with `subject.parentOf` (parent adoption both ways): a convenience, not a safety rule; it needs real queries to prove well (see below).
- `placedOn`, `releasedVotes`: read-only summaries built on `placedVotes`, which the withdraw test exercises.
- `getNoticeRules` query building: the access test covers who sees what; the query is a plain filter.
- Field layout and admin descriptions: Payload config.

### Bugs found

None confirmed.

### For the lead

- **Possible voting gap:** `src/collections.ts:245` forces the voter, ballot and weight only when `req.user.collection` is `usersSlug`. A signed-in account from another auth collection that passes `access.vote` (default: any signed-in user) and isn't a curator could create a vote for any user with any weight. Decide whether the default `vote` should also check the collection, or the hook should refuse other collections.
- Tests against a real (in-memory) database for the unique indexes, concurrent requests and `parentOf` grouping, since the fakes here can't prove index behavior.
