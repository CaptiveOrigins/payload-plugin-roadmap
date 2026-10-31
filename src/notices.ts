import type { CollectionConfig, CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import type { ResolvedRoadmapOptions, RoadmapNotice } from './types'

/**
 * Notice rules: an editor ticks values of the configured fields (any match
 * counts) and writes the message voters see on matching items, optionally
 * asking them to confirm before they vote or request.
 */
export const noticesCollection = (opts: ResolvedRoadmapOptions): CollectionConfig => {
  const { manage } = opts.access
  return {
    slug: opts.slugs.notices,
    labels: { singular: 'Roadmap notice', plural: 'Roadmap notices' },
    admin: {
      useAsTitle: 'title',
      group: 'Roadmap',
      defaultColumns: ['title', 'board', 'active', 'confirm'],
      description: 'Messages shown to voters when an entry matches the ticked values (any of them).',
    },
    access: {
      create: manage,
      update: manage,
      delete: manage,
      // The public sees active rules (their messages are public anyway).
      read: async (args) => {
        const managed = await manage(args)
        if (managed === true) return true
        const active: Where = { active: { equals: true } }
        return managed ? { or: [managed as Where, active] } : active
      },
    },
    fields: [
      { name: 'title', type: 'text', required: true, admin: { description: 'For editors, e.g. "CITES I and ESA species".' } },
      {
        type: 'row',
        fields: [
          { name: 'board', type: 'select', required: true, defaultValue: opts.boards[0]!.value, options: opts.boards, index: true },
          { name: 'active', type: 'checkbox', defaultValue: true, index: true },
          {
            name: 'confirm',
            type: 'checkbox',
            defaultValue: false,
            admin: { description: 'Ask voters to read it and confirm before voting or requesting.' },
          },
        ],
      },
      {
        name: 'when',
        type: 'group',
        admin: { description: 'Shown when an entry has any of these values.' },
        fields: opts.notices.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: 'select' as const,
          hasMany: true,
          options: f.options,
          ...(f.boards ? { admin: { condition: (data: Record<string, unknown>) => f.boards!.includes(String(data?.board)) } } : {}),
        })),
      },
      { name: 'message', type: 'textarea', required: true, localized: true, maxLength: 2000 },
      { name: 'order', type: 'number', defaultValue: 0, admin: { position: 'sidebar', description: 'Lower first when several match.' } },
    ],
  }
}

export type NoticeRule = RoadmapNotice & { when: Record<string, string[]> }

/** The active rules of a board (and scope), lowest `order` first. */
export async function getNoticeRules(
  payload: Payload,
  args: { board: string; scope?: string; locale?: string; req?: PayloadRequest },
): Promise<NoticeRule[]> {
  const opts = payload.config.custom?.roadmap as ResolvedRoadmapOptions | undefined
  if (!opts?.notices.fields.length) return []
  const where: Where[] = [{ board: { equals: args.board } }, { active: { equals: true } }]
  if (opts.scopeField && args.scope) where.push({ [opts.scopeField]: { equals: args.scope } })
  const { docs } = await payload.find({
    collection: opts.slugs.notices as CollectionSlug,
    where: { and: where },
    sort: 'order',
    pagination: false,
    depth: 0,
    overrideAccess: true,
    ...(args.locale ? { locale: args.locale as never } : {}),
    req: args.req,
  })
  return (docs as unknown as { id: string; message?: string; confirm?: boolean; when?: Record<string, string[] | null> }[])
    .filter((d) => d.message)
    .map((d) => ({
      id: String(d.id),
      message: d.message!,
      confirm: Boolean(d.confirm),
      when: Object.fromEntries(Object.entries(d.when ?? {}).map(([k, v]) => [k, v ?? []])),
    }))
}

/** Rules whose ticked values meet the entry's values (field name → values). */
export const matchingNotices = (rules: NoticeRule[], values: Record<string, string[]>): RoadmapNotice[] =>
  rules
    .filter((r) => Object.entries(r.when).some(([field, ticked]) => ticked.some((v) => values[field]?.includes(v))))
    .map(({ id, message, confirm }) => ({ id, message, confirm }))
