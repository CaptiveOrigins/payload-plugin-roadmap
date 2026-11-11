import type { Plugin } from 'payload'

import { itemsCollection, votesCollection } from './collections'
import { categoriesCollection } from './catalog'
import { docsAfterChange, docsAfterDelete, docsFeatures } from './docs'
import { noticesCollection } from './notices'
import type { ResolvedRoadmapOptions, RoadmapPluginOptions } from './types'

export type { CatalogStatus, RoadmapNotice, RoadmapNoticeField, RoadmapOption, RoadmapPluginOptions, ResolvedRoadmapOptions } from './types'
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
export { catalogStatus, getCatalog } from './catalog'
export { docsFeatures, type DocsFeature } from './docs'
export type { CatalogEntry, CatalogSection } from './catalog'

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
  slugs: { items: 'roadmap-items', votes: 'roadmap-votes', notices: 'roadmap-notices', categories: 'roadmap-categories', ...o.slugs },
  notices: { fields: o.notices?.fields ?? [] },
  catalog: o.catalog
    ? {
        boards: o.catalog.boards ?? ['features'],
        availableStages: o.catalog.availableStages ?? ['released'],
        progressStages: o.catalog.progressStages ?? ['in-progress'],
        hiddenStages: o.catalog.hiddenStages ?? ['declined'],
        ...(o.catalog.docs ? { docs: { name: (typeof o.catalog.docs === 'object' && o.catalog.docs.name) || 'roadmap-catalog' } } : {}),
      }
    : undefined,
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
    const categories = opts.catalog ? [(options.overrides?.categories ?? ((c) => c))(categoriesCollection(opts))] : []
    const docs = opts.catalog?.docs
    if (docs) items.hooks = { ...items.hooks, afterChange: [...(items.hooks?.afterChange ?? []), docsAfterChange], afterDelete: [...(items.hooks?.afterDelete ?? []), docsAfterDelete] }
    return {
      ...config,
      collections: [...(config.collections ?? []), items, votes, ...notices, ...categories],
      custom: {
        ...config.custom,
        roadmap: opts,
        // A docs plugin reads this when it runs, in any plugin order: no import either way.
        ...(docs ? { docsSources: [...((config.custom?.docsSources as unknown[]) ?? []), { name: docs.name, list: async ({ payload }: { payload: Parameters<typeof docsFeatures>[0] }) => docsFeatures(payload) }] } : {}),
      },
    }
  }
