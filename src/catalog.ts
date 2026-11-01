import type { CollectionConfig, CollectionSlug, Field, Payload, PayloadRequest, Where } from 'payload'

import { idOf, slugify } from './api'
import type { CatalogStatus, ResolvedRoadmapOptions } from './types'

/** The label of a catalog entry from its stage and audience; null when it is left out. */
export function catalogStatus(opts: ResolvedRoadmapOptions, stage: string, audience?: string | null): CatalogStatus | null {
  const c = opts.catalog
  if (!c || c.hiddenStages.includes(stage)) return null
  if (c.availableStages.includes(stage)) return audience === 'members' ? 'members' : 'available'
  if (c.progressStages.includes(stage)) return 'in-progress'
  return 'planned'
}

/** Catalog categories: the sections of the catalog (and categories of its boards). */
export const categoriesCollection = (opts: ResolvedRoadmapOptions): CollectionConfig => ({
  slug: opts.slugs.categories,
  labels: { singular: 'Catalog category', plural: 'Catalog categories' },
  admin: { group: 'Roadmap', useAsTitle: 'title', defaultColumns: ['title', 'order', 'updatedAt'], description: 'Sections of the features catalog.' },
  access: { read: () => true, create: opts.access.manage, update: opts.access.manage, delete: opts.access.manage },
  defaultPopulate: { title: true, slug: true },
  indexes: [{ fields: [...(opts.scopeField ? [opts.scopeField] : []), 'slug'], unique: true }],
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', index: true, admin: { position: 'sidebar', description: 'From the title if left empty.' } },
    { name: 'summary', type: 'text', admin: { description: 'One line, for overview cards.' } },
    { name: 'intro', type: 'textarea', admin: { description: 'Opening paragraph of the section.' } },
    { name: 'order', type: 'number', defaultValue: 100, index: true, admin: { position: 'sidebar', description: 'Lower comes first.' } },
  ],
  hooks: {
    beforeChange: [
      ({ data }) => {
        if (!data.slug && data.title) data.slug = slugify(String(data.title))
        return data
      },
    ],
  },
  timestamps: true,
})

/** Catalog fields on items of the catalog boards. */
export const catalogItemFields = (opts: ResolvedRoadmapOptions): Field[] => {
  if (!opts.catalog) return []
  const boards = opts.catalog.boards
  const condition = (data: Record<string, unknown> | undefined) => boards.includes(String(data?.board ?? ''))
  return [
    {
      name: 'category',
      type: 'relationship',
      relationTo: opts.slugs.categories as CollectionSlug,
      index: true,
      admin: { position: 'sidebar', condition, description: 'Section of the catalog.' },
    },
    {
      name: 'audience',
      type: 'select',
      defaultValue: 'everyone',
      options: [
        { label: 'Everyone', value: 'everyone' },
        { label: 'Members (account or role needed)', value: 'members' },
      ],
      admin: { position: 'sidebar', condition, description: 'Available entries show as Available or Members.' },
    },
    { name: 'order', type: 'number', defaultValue: 100, admin: { position: 'sidebar', condition, description: 'Order within its section; lower first.' } },
    {
      name: 'details',
      type: 'array',
      labels: { singular: 'Detail', plural: 'Details' },
      admin: { condition, description: 'Points shown in the catalog: what it does and its limits.' },
      fields: [{ name: 'text', type: 'textarea', required: true }],
    },
    {
      name: 'links',
      type: 'array',
      admin: { condition, description: 'Where to try it: site paths (/…) or https links.' },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'label', type: 'text', required: true },
            { name: 'href', type: 'text', required: true, validate: (v: unknown) => (typeof v === 'string' && /^(\/|https:\/\/)/.test(v) ? true : 'Start with / or https://') },
          ],
        },
      ],
    },
  ]
}

export type CatalogEntry = {
  id: string
  slug: string
  title: string
  summary: string | null
  status: CatalogStatus
  details: string[]
  links: { label: string; href: string }[]
  votes: number
}

export type CatalogSection = { id: string; slug: string; title: string; summary: string | null; intro: string | null; entries: CatalogEntry[] }

type ItemDoc = {
  id: string
  slug?: string | null
  title: string
  summary?: string | null
  stage: string
  audience?: string | null
  category?: unknown
  details?: { text: string }[] | null
  links?: { label: string; href: string }[] | null
  voteCount?: number | null
}

/**
 * The catalog: every category with its entries, in order. Reads with access
 * control unless `overrideAccess` (pass `req` or `user` to read as someone).
 * Entries without a category, hidden items and hidden stages are left out.
 */
export async function getCatalog(
  payload: Payload,
  args: { scope?: string; board?: string; req?: Partial<PayloadRequest>; overrideAccess?: boolean } = {},
): Promise<CatalogSection[]> {
  const opts = payload.config.custom.roadmap as ResolvedRoadmapOptions
  if (!opts.catalog) throw new Error('The roadmap catalog is not enabled.')
  const scoped = (where: Where[]): Where => ({ and: [...where, ...(opts.scopeField && args.scope ? [{ [opts.scopeField]: { equals: args.scope } }] : [])] })
  const read = { overrideAccess: args.overrideAccess ?? false, req: args.req, depth: 0, pagination: false as const }
  const [categories, items] = await Promise.all([
    payload.find({ collection: opts.slugs.categories as CollectionSlug, where: scoped([]), sort: 'order', ...read }),
    payload.find({
      collection: opts.slugs.items as CollectionSlug,
      where: scoped([
        { board: { in: args.board ? [args.board] : opts.catalog.boards } },
        { hidden: { not_equals: true } },
        { category: { exists: true } },
      ]),
      sort: 'order',
      joins: false,
      ...read,
    }),
  ])
  const byCategory = new Map<string, CatalogEntry[]>()
  for (const i of items.docs as unknown as ItemDoc[]) {
    const status = catalogStatus(opts, i.stage, i.audience)
    const category = idOf(i.category)
    if (!status || !category) continue
    byCategory.set(category, [
      ...(byCategory.get(category) ?? []),
      {
        id: String(i.id),
        slug: i.slug ?? String(i.id),
        title: i.title,
        summary: i.summary ?? null,
        status,
        details: (i.details ?? []).map((d) => d.text),
        links: (i.links ?? []).map((l) => ({ label: l.label, href: l.href })),
        votes: i.voteCount ?? 0,
      },
    ])
  }
  return (categories.docs as unknown as { id: string; slug?: string | null; title: string; summary?: string | null; intro?: string | null }[]).map((c) => ({
    id: String(c.id),
    slug: c.slug ?? String(c.id),
    title: c.title,
    summary: c.summary ?? null,
    intro: c.intro ?? null,
    entries: byCategory.get(String(c.id)) ?? [],
  }))
}
