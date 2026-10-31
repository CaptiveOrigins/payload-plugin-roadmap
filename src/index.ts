import type { Plugin } from 'payload'

import { itemsCollection, votesCollection } from './collections'
import { noticesCollection } from './notices'
import type { ResolvedRoadmapOptions, RoadmapPluginOptions } from './types'

export type { RoadmapNotice, RoadmapNoticeField, RoadmapOption, RoadmapPluginOptions, ResolvedRoadmapOptions } from './types'
export { getNoticeRules, matchingNotices } from './notices'
export type { NoticeRule } from './notices'
export {
  allocateVotes,
  castVote,
  findItem,
  FREE_BALLOT,
  itemKey,
  keepVotes,
  mergeItems,
  recountVotes,
  releases,
  releasedVotes,
  removeVote,
  RoadmapError,
  requestItem,
  slugify,
  placedOn,
  unlocksAt,
  voteBalance,
  withdrawVotes,
} from './api'
export type { RoadmapItemDoc } from './api'

export const DEFAULT_STAGES = [
  { label: 'Requested', value: 'requested' },
  { label: 'Under review', value: 'under-review' },
  { label: 'Planned', value: 'planned' },
  { label: 'In progress', value: 'in-progress' },
  { label: 'Released', value: 'released' },
  { label: 'Not planned', value: 'declined' },
]

const resolve = (o: RoadmapPluginOptions): ResolvedRoadmapOptions => ({
  usersSlug: o.usersSlug ?? 'users',
  boards: o.boards?.length ? o.boards : [{ label: 'Features', value: 'features' }],
  stages: o.stages?.length ? o.stages : DEFAULT_STAGES,
  subject: o.subject,
  scopeField: o.scopeField,
  allocation: o.allocation,
  slugs: { items: 'roadmap-items', votes: 'roadmap-votes', notices: 'roadmap-notices', ...o.slugs },
  notices: { fields: o.notices?.fields ?? [] },
  access: {
    manage: o.access?.manage ?? (() => false),
    vote: o.access?.vote ?? (({ req }) => Boolean(req.user)),
  },
})

/**
 * A public roadmap with one vote per user per item. Items move through
 * curator-set stages; votes inform priorities and never change a stage by
 * themselves. Requests for the same subject (e.g. a taxon) land on one item,
 * and items can group under a parent item.
 */
export const roadmapPlugin =
  (options: RoadmapPluginOptions = {}): Plugin =>
  (config) => {
    const opts = resolve(options)
    const items = (options.overrides?.items ?? ((c) => c))(itemsCollection(opts))
    const votes = (options.overrides?.votes ?? ((c) => c))(votesCollection(opts))
    const notices = opts.notices.fields.length ? [(options.overrides?.notices ?? ((c) => c))(noticesCollection(opts))] : []
    return {
      ...config,
      collections: [...(config.collections ?? []), items, votes, ...notices],
      custom: { ...config.custom, roadmap: opts },
    }
  }
