import { APIError, type Access, type CollectionConfig, type CollectionSlug, type Field, type Where } from 'payload'

import { idOf, itemKey, recountVotes, slugify } from './api'
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
      admin: { position: 'sidebar', readOnly: true, description: 'Counted from the votes.' },
      access: { create: () => false, update: () => false },
    },
    {
      name: 'hidden',
      type: 'checkbox',
      defaultValue: false,
      admin: { position: 'sidebar', description: 'Hide from the public roadmap (spam, duplicates).' },
    },
    {
      name: 'requestedBy',
      type: 'relationship',
      relationTo: opts.usersSlug as CollectionSlug,
      admin: { position: 'sidebar', readOnly: true },
      access: { read: ({ req }) => Boolean(req.user) },
    },
    { name: 'votes', type: 'join', collection: opts.slugs.votes as CollectionSlug, on: 'item', admin: { allowCreate: false } },
  ]
  return {
    slug: opts.slugs.items,
    admin: { useAsTitle: 'title', group: 'Roadmap', defaultColumns: ['title', 'board', 'stage', 'voteCount', 'updatedAt'] },
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
    admin: { group: 'Roadmap', defaultColumns: ['item', 'user', 'createdAt'] },
    access: {
      create: vote,
      read: manageOrOwn(manage, 'user'),
      delete: manageOrOwn(manage, 'user'),
      update: manage,
    },
    indexes: [{ fields: ['item', 'user'], unique: true }],
    fields: [
      { name: 'item', type: 'relationship', relationTo: opts.slugs.items as CollectionSlug, required: true, index: true },
      { name: 'user', type: 'relationship', relationTo: opts.usersSlug as CollectionSlug, required: true, index: true },
      { name: 'note', type: 'textarea', maxLength: 1000, admin: { description: 'Why the voter wants this (curators only).' } },
    ],
    hooks: {
      beforeChange: [
        async ({ data, operation, req }) => {
          if (operation !== 'create') return data
          // API voters vote as themselves.
          if (req.user && req.user.collection === opts.usersSlug && (await manage({ req })) !== true) data.user = req.user.id
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
      afterDelete: [
        async ({ doc, req }) => {
          await recountVotes(req.payload, idOf(doc.item), req)
          return doc
        },
      ],
    },
  }
}
