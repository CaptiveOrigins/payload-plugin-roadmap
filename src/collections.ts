import { APIError, type Access, type CollectionConfig, type CollectionSlug, type Field, type Where } from 'payload'

import { FREE_BALLOT, idOf, itemKey, mergeItems, recountVotes, releases, slugify, unlocksAt } from './api'
import { catalogItemFields } from './catalog'
import type { ResolvedRoadmapOptions } from './types'

/** manage, else the signed-in user's own records (by `field`). */
const manageOrOwn =
  (manage: Access, field: string): Access =>
  async (args) => {
    const managed = await manage(args)
    if (managed === true) return true
    if (!args.req.user) return managed
    const own: Where = { [field]: { equals: args.req.user.id } }
    return managed ? { or: [managed as Where, own] } : own
  }

export const itemsCollection = (opts: ResolvedRoadmapOptions): CollectionConfig => {
  const { manage } = opts.access
  const scoped = (where: Where[], doc: Record<string, unknown>) =>
    opts.scopeField && doc[opts.scopeField] ? [...where, { [opts.scopeField]: { equals: idOf(doc[opts.scopeField]) } }] : where
  const fields: Field[] = [
    { name: 'title', type: 'text', required: true },
    {
      type: 'row',
      fields: [
        { name: 'board', type: 'select', required: true, defaultValue: opts.boards[0]!.value, options: opts.boards, index: true },
        { name: 'stage', type: 'select', required: true, defaultValue: opts.stages[0]!.value, options: opts.stages, index: true },
      ],
    },
    ...(opts.subject
      ? ([
          {
            name: 'subject',
            type: 'relationship',
            relationTo: opts.subject.relationTo as CollectionSlug,
            index: true,
            ...(opts.subject.filterOptions ? { filterOptions: opts.subject.filterOptions } : {}),
            admin: { description: 'What this item is about. One item per subject on each board.' },
          },
          { name: 'parentSubject', type: 'text', index: true, admin: { hidden: true } },
        ] as Field[])
      : []),
    {
      name: 'parent',
      type: 'relationship',
      relationTo: opts.slugs.items as CollectionSlug,
      admin: { description: 'Groups this item under another (e.g. a subspecies under its species).' },
    },
    { name: 'summary', type: 'textarea' },
    {
      name: 'slug',
      type: 'text',
      index: true,
      admin: { position: 'sidebar', description: 'From the title when empty.' },
    },
    { name: 'key', type: 'text', index: true, admin: { hidden: true } },
    {
      name: 'voteCount',
      type: 'number',
      defaultValue: 0,
      index: true,
      admin: { position: 'sidebar', readOnly: true, description: 'Votes, counted from the vote records (placed votes count by weight).' },
      access: { create: () => false, update: () => false },
    },
    {
      name: 'voterCount',
      type: 'number',
      defaultValue: 0,
      admin: { position: 'sidebar', readOnly: true, description: 'People who voted.' },
      access: { create: () => false, update: () => false },
    },
    {
      name: 'hidden',
      type: 'checkbox',
      defaultValue: false,
      admin: { position: 'sidebar', description: 'Hide from the public roadmap (spam, duplicates).' },
    },
    {
      name: 'mergedInto',
      type: 'relationship',
      relationTo: opts.slugs.items as CollectionSlug,
      admin: {
        position: 'sidebar',
        description: 'Combine this item into a similar one: its votes move there and this item is hidden. Cannot be undone.',
      },
      filterOptions: ({ id, data }): Where => ({
        and: [{ id: { not_equals: id } }, { board: { equals: data?.board } }, { mergedInto: { exists: false } }] as Where[],
      }),
    },
    {
      name: 'requestedBy',
      type: 'relationship',
      relationTo: opts.usersSlug as CollectionSlug,
      admin: { position: 'sidebar', readOnly: true },
      access: { read: ({ req }) => Boolean(req.user) },
    },
    { name: 'votes', type: 'join', collection: opts.slugs.votes as CollectionSlug, on: 'item', admin: { allowCreate: false } },
    ...catalogItemFields(opts),
  ]
  return {
    slug: opts.slugs.items,
    admin: { useAsTitle: 'title', group: 'Roadmap', defaultColumns: ['title', 'board', 'stage', 'voterCount', 'voteCount', 'updatedAt'] },
    access: {
      create: manage,
      update: manage,
      delete: manage,
      // The public sees items that are not hidden.
      read: async (args) => {
        const managed = await manage(args)
        if (managed === true) return true
        const visible: Where = { hidden: { not_equals: true } }
        return managed ? { or: [managed as Where, visible] } : visible
      },
    },
    indexes: [{ fields: [...(opts.scopeField ? [opts.scopeField] : []), 'board', 'key'], unique: true }],
    fields,
    hooks: {
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          if (data.mergedInto && idOf(data.mergedInto) !== idOf(originalDoc?.mergedInto)) {
            if (originalDoc?.mergedInto) throw new APIError('This item was already merged.', 400)
            const into = (await req.payload.findByID({
              collection: opts.slugs.items as CollectionSlug,
              id: idOf(data.mergedInto),
              depth: 0,
              overrideAccess: true,
              disableErrors: true,
              req,
            })) as Record<string, unknown> | null
            const doc = { ...originalDoc, ...data }
            if (
              !into ||
              into.id === originalDoc?.id ||
              into.mergedInto ||
              into.board !== doc.board ||
              (opts.scopeField && idOf(into[opts.scopeField]) !== idOf(doc[opts.scopeField]))
            )
              throw new APIError('Merge into another live item on the same roadmap.', 400)
          }
          const slug = data.slug || originalDoc?.slug || slugify(String(data.title ?? originalDoc?.title ?? ''))
          if (!slug) throw new APIError('A title is required.', 400)
          const subject = 'subject' in data ? data.subject : originalDoc?.subject
          const subjectChanged = operation === 'create' || idOf(subject) !== idOf(originalDoc?.subject)
          const next: Record<string, unknown> = { ...data, slug, key: itemKey(subject, slug) }
          if (opts.subject?.parentOf && subjectChanged) {
            const parentSubject = idOf(subject) ? await opts.subject.parentOf({ id: idOf(subject), req }) : null
            next.parentSubject = parentSubject ?? null
            if (parentSubject && !data.parent) {
              const doc = { ...originalDoc, ...data }
              const { docs } = await req.payload.find({
                collection: opts.slugs.items as CollectionSlug,
                where: { and: scoped([{ board: { equals: doc.board } }, { key: { equals: `subject:${parentSubject}` } }], doc) },
                limit: 1,
                // One query (no count) inside the caller's transaction.
                pagination: false,
                depth: 0,
                overrideAccess: true,
                req,
              })
              if (docs[0]) next.parent = docs[0].id
            }
          }
          return next
        },
      ],
      afterChange: [
        // Merging, and asking voters again when an item enters a release stage.
        async ({ doc, previousDoc, operation, req, context }) => {
          if (context.roadmapInternal || operation !== 'update') return doc
          if (doc.mergedInto && !previousDoc?.mergedInto)
            await mergeItems(req.payload, { from: doc.id, into: idOf(doc.mergedInto), req })
          else if (releases(opts, doc.stage) && !releases(opts, previousDoc?.stage))
            await req.payload.update({
              collection: opts.slugs.votes as CollectionSlug,
              where: { and: [{ item: { equals: doc.id } }, { kept: { equals: true } }] },
              data: { kept: false } as never,
              overrideAccess: true,
              req,
            })
          return doc
        },
        // An item for a parent subject adopts the existing items of its children.
        async ({ doc, previousDoc, operation, req, context }) => {
          if (context.roadmapInternal || !opts.subject?.parentOf || !idOf(doc.subject)) return doc
          if (operation !== 'create' && idOf(doc.subject) === idOf(previousDoc?.subject)) return doc
          await req.payload.update({
            collection: opts.slugs.items as CollectionSlug,
            where: {
              and: scoped(
                [{ board: { equals: doc.board } }, { parentSubject: { equals: idOf(doc.subject) } }, { parent: { exists: false } }],
                doc,
              ),
            },
            data: { parent: doc.id } as never,
            overrideAccess: true,
            context: { roadmapInternal: true },
            req,
          })
          return doc
        },
      ],
    },
  }
}

export const votesCollection = (opts: ResolvedRoadmapOptions): CollectionConfig => {
  const { manage, vote } = opts.access
  return {
    slug: opts.slugs.votes,
    admin: { group: 'Roadmap', defaultColumns: ['item', 'user', 'weight', 'createdAt'] },
    access: {
      create: vote,
      read: manageOrOwn(manage, 'user'),
      delete: manageOrOwn(manage, 'user'),
      update: manage,
    },
    // One free vote per user per item; each placement of extra votes has its own ballot.
    indexes: [{ fields: ['item', 'user', 'ballot'], unique: true }],
    fields: [
      { name: 'item', type: 'relationship', relationTo: opts.slugs.items as CollectionSlug, required: true, index: true },
      { name: 'user', type: 'relationship', relationTo: opts.usersSlug as CollectionSlug, required: true, index: true },
      {
        name: 'ballot',
        type: 'text',
        required: true,
        defaultValue: FREE_BALLOT,
        index: true,
        admin: { readOnly: true, description: '"free" for the one free vote; extra votes placed from a balance have their own.' },
      },
      { name: 'weight', type: 'number', required: true, defaultValue: 1, min: 1, admin: { readOnly: true } },
      { name: 'note', type: 'textarea', maxLength: 1000, admin: { description: 'Why the voter wants this (curators only).' } },
      {
        name: 'kept',
        type: 'checkbox',
        defaultValue: false,
        admin: { readOnly: true, description: 'The voter chose to keep these placed votes on an item that released them.' },
      },
    ],
    hooks: {
      beforeChange: [
        async ({ data, operation, req }) => {
          if (operation !== 'create') return data
          // API voters cast their own free vote; extra votes go through allocateVotes.
          if (req.user && req.user.collection === opts.usersSlug && (await manage({ req })) !== true) {
            data.user = req.user.id
            data.ballot = FREE_BALLOT
            data.weight = 1
          }
          const item = await req.payload.findByID({
            collection: opts.slugs.items as CollectionSlug,
            id: idOf(data.item),
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (!item || (item as { hidden?: boolean }).hidden) throw new APIError('That roadmap item is not open for votes.', 400)
          if (opts.scopeField) data[opts.scopeField] = idOf((item as unknown as Record<string, unknown>)[opts.scopeField]) || undefined
          return data
        },
      ],
      afterChange: [
        async ({ doc, operation, req }) => {
          if (operation === 'create') await recountVotes(req.payload, idOf(doc.item), req)
          return doc
        },
      ],
      beforeDelete: [
        // Voters can't withdraw placed votes through the API before they unlock.
        async ({ id, req }) => {
          if (!req.user || (await manage({ req })) === true) return
          const vote = (await req.payload.findByID({ collection: opts.slugs.votes as CollectionSlug, id, depth: 1, overrideAccess: true, req })) as unknown as {
            ballot?: string
            createdAt: string
            item?: { stage?: string } | string
          }
          const stage = typeof vote.item === 'object' ? vote.item?.stage : undefined
          if (vote.ballot !== FREE_BALLOT && unlocksAt(opts, vote.createdAt, stage)) throw new APIError('These votes are still committed.', 403)
        },
      ],
      afterDelete: [
        async ({ doc, req }) => {
          await recountVotes(req.payload, idOf(doc.item), req)
          return doc
        },
      ],
    },
  }
}
