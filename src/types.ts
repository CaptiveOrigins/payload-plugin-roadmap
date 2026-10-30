import type { Access, CollectionConfig, Payload, PayloadRequest, Where } from 'payload'

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
  /**
   * Extra ("free agent") votes a user can place anywhere, several on one item
   * or spread across many, on top of their one free vote per item. The app
   * says how many each user has earned (e.g. from gifts); placed votes are
   * spent at once and counted from the votes themselves.
   */
  allocation?: {
    /** Votes the user has earned in this scope (whole or fractional; the plugin floors the total). */
    earned: (args: { payload: Payload; user: string; scope?: string; req?: PayloadRequest }) => Promise<number>
    /** Days before placed votes can be withdrawn back to the balance. Default 0. */
    lockDays?: number
    /** Boards that accept placed votes. Default: all. */
    boards?: string[]
    /**
     * Stages that release placed votes at once (e.g. "declined"): the voter
     * chooses to move them (withdraw, whatever the lock) or keep them there.
     */
    releaseStages?: string[]
  }
  overrides?: {
    items?: (collection: CollectionConfig) => CollectionConfig
    votes?: (collection: CollectionConfig) => CollectionConfig
  }
}

export type ResolvedRoadmapOptions = Required<Pick<RoadmapPluginOptions, 'usersSlug' | 'boards' | 'stages'>> &
  Pick<RoadmapPluginOptions, 'subject' | 'scopeField' | 'allocation'> & {
    slugs: { items: string; votes: string }
    access: { manage: Access; vote: Access }
  }
