import type { Access, CollectionConfig, PayloadRequest, Where } from 'payload'

export type RoadmapOption = { label: string; value: string }

export type RoadmapPluginOptions = {
  slugs?: { items?: string; votes?: string }
  /** The auth collection whose accounts vote. Default 'users'. */
  usersSlug?: string
  /** Separate roadmaps, e.g. features and species. Default: one board, "features". */
  boards?: RoadmapOption[]
  /** Workflow stages, first = where new requests start. */
  stages?: RoadmapOption[]
  /**
   * Optional thing each item is about (a taxon, a product…). Items are unique
   * per subject within a board, so a second request for the same subject
   * finds the existing item instead of creating a duplicate.
   */
  subject?: {
    relationTo: string
    /** Limits which subjects can be chosen in the admin (e.g. only species). */
    filterOptions?: Where
    /**
     * The subject's parent subject, if items for it should group under an
     * item for the parent (subspecies under their species). Items adopt
     * children whichever is requested first.
     */
    parentOf?: (args: { id: string; req: PayloadRequest }) => Promise<string | null>
  }
  /**
   * A field both collections share that partitions roadmaps, e.g. 'tenant'
   * with the multi-tenant plugin. Uniqueness and grouping stay inside it. The
   * plugin does not add this field.
   */
  scopeField?: string
  access?: {
    /** Who edits items and sees all votes (curators). Default: nobody (Local API only). */
    manage?: Access
    /** Who may cast/remove their own vote through the REST/GraphQL API. Default: any signed-in user. */
    vote?: Access
  }
  overrides?: {
    items?: (collection: CollectionConfig) => CollectionConfig
    votes?: (collection: CollectionConfig) => CollectionConfig
  }
}

export type ResolvedRoadmapOptions = Required<Pick<RoadmapPluginOptions, 'usersSlug' | 'boards' | 'stages'>> &
  Pick<RoadmapPluginOptions, 'subject' | 'scopeField'> & {
    slugs: { items: string; votes: string }
    access: { manage: Access; vote: Access }
  }
