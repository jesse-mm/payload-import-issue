// @vitest-environment node
// Upload file-type detection needs Node's Buffer, which the template's jsdom environment breaks.
import { getPayload, Payload } from 'payload'
import config from '@/payload.config'

import { beforeAll, describe, expect, it } from 'vitest'

let payload: Payload
let user: Awaited<ReturnType<Payload['create']>>
let authorID: number | string

const idleInTransaction = async (): Promise<number> => {
  const { rows } = await (payload.db as any).pool.query(
    `select count(*)::int as count from pg_stat_activity
     where datname = current_database() and state = 'idle in transaction'`,
  )
  return rows[0].count
}

const openSessions = (): number => Object.keys((payload.db as any).sessions ?? {}).length

const importOnePost = (title: string) => {
  const data = Buffer.from(JSON.stringify([{ title, author: authorID }]))
  return payload.create({
    collection: 'imports',
    data: { collectionSlug: 'posts', importMode: 'create' },
    file: { data, mimetype: 'application/json', name: `${title}.json`, size: data.length },
    user,
  })
}

describe('synchronous import (disableJobsQueue: true)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    user = await payload.create({
      collection: 'users',
      data: { email: `import-${Date.now()}@example.com`, password: 'test' },
    })
    const author = await payload.create({ collection: 'authors', data: { name: 'Jane Doe' } })
    authorID = author.id
  })

  it('imports the post', async () => {
    const result = await importOnePost('First post')
    expect(result.status).toBe('completed')

    const posts = await payload.find({ collection: 'posts', where: { title: { equals: 'First post' } } })
    expect(posts.totalDocs).toBe(1)
  })

  it('commits the import transaction instead of leaving it open', async () => {
    const sessionsBefore = openSessions()
    const idleBefore = await idleInTransaction()

    const result = await importOnePost('Second post')
    expect(result.status).toBe('completed')

    // Fails on 3.92.1: the import's create transaction is never committed or rolled back.
    expect(openSessions()).toBe(sessionsBefore)
    expect(await idleInTransaction()).toBe(idleBefore)
  })

  it('stores the import document', async () => {
    const result = await importOnePost('Third post')

    // Fails on 3.92.1: the import document only exists inside the uncommitted transaction.
    const stored = await payload.find({ collection: 'imports', where: { id: { equals: result.id } } })
    expect(stored.totalDocs).toBe(1)
  })
})
