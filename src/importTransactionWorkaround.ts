import { getDataLoader, isolateObjectProperty } from 'payload'
import type { CollectionAfterChangeHook, CollectionConfig } from 'payload'

/**
 * Workaround for synchronous imports leaking their create transaction.
 *
 * The plugin runs every imported document through a request copy that shares the parent request's
 * DataLoader. Populating a relationship writes the copy's transaction ID onto the parent request,
 * so the import's own transaction is never committed. Running the plugin's hooks with a DataLoader
 * bound to an isolated request keeps the parent transaction ID intact.
 */
const withIsolatedImportTransaction =
  (hook: CollectionAfterChangeHook): CollectionAfterChangeHook =>
  async (args) => {
    const { req } = args
    const dataLoader = req.payloadDataLoader
    req.payloadDataLoader = getDataLoader(isolateObjectProperty(req, 'transactionID'))

    try {
      return await hook(args)
    } finally {
      req.payloadDataLoader = dataLoader
    }
  }

export const overrideImportCollection = ({
  collection,
}: {
  collection: CollectionConfig
}): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    afterChange: (collection.hooks?.afterChange ?? []).map(withIsolatedImportTransaction),
  },
})
