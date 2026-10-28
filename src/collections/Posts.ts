import type { CollectionConfig } from 'payload'

export const Posts: CollectionConfig = {
  slug: 'posts',
  admin: {
    useAsTitle: 'title',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      // Any relationship works: populating it during the import triggers the bug.
      name: 'author',
      type: 'relationship',
      relationTo: 'authors',
    },
  ],
}
