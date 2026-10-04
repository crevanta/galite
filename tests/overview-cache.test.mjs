import test from 'node:test'
import assert from 'node:assert/strict'
import { createOverviewCache } from '../server/utils/overview-cache-core.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const stale = { state: 'stale', updatedAt: 500, payload: { projects: ['old'] } }
function fixture(entry) {
  let version = 0
  const rows = new Map(entry ? [['one', entry]] : []), jobs = [], writes = []
  const load = createOverviewCache({
    read: async key => rows.get(key), readVersion: async () => version,
    write: async (key, payload, expected) => {
      if (expected !== version) return false
      writes.push(payload); rows.set(key, { state: 'hit', updatedAt: 1000, payload }); return true
    }, now: () => 1000,
  })
  return { load, rows, jobs, writes, invalidate() { version++; rows.clear() },
    get: options => load({ key: 'one', waitUntil: p => jobs.push(p), ...options }) }
}

test('stale visits return immediately and share one background rebuild', async () => {
  const f = fixture(stale), d = deferred(); let calls = 0
  const build = () => { calls++; return d.promise }
  const values = await Promise.all([f.get({ build }), f.get({ build })])
  assert.equal(calls, 1); assert.ok(values.every(v => v.refreshing && v.projects[0] === 'old'))
  d.resolve({ projects: ['fresh'] }); await Promise.all(f.jobs)
  assert.equal(f.writes.length, 1)
  assert.deepEqual((await f.get({ build: () => assert.fail('fresh hit must not rebuild') })).projects, ['fresh'])
})

test('cold requests share work; manual refresh bypasses fresh cache', async () => {
  const f = fixture(), d = deferred(); let calls = 0
  const build = () => { calls++; return d.promise }
  const a = f.get({ build }), b = f.get({ build }); await tick(); assert.equal(calls, 1)
  d.resolve({ projects: ['fresh'] }); await Promise.all([a, b])
  assert.deepEqual((await f.get({ refresh: true, build: async () => ({ projects: ['forced'] }) })).projects, ['forced'])
})

for (const entry of [undefined, stale]) {
  test(`invalidation during ${entry ? 'stale' : 'cold'} work cannot repopulate cache or return old data to a waiting request`, async () => {
    const f = fixture(entry), d = deferred(); let calls = 0
    const old = f.get({ refresh: true, build: async () => ++calls === 1 ? d.promise : { projects: ['new'] } })
    await tick(); f.invalidate()
    // New requests do not join the previous generation's pending promise.
    const fresh = await f.get({ build: async () => ({ projects: ['new'] }) })
    assert.deepEqual(fresh.projects, ['new'])
    d.resolve({ projects: ['deleted'] })
    assert.deepEqual((await old).projects, ['new'])
    assert.ok(f.writes.every(v => !v.projects.includes('deleted')))
  })
}

test('atomic rejection after the final version check triggers a fresh rebuild', async () => {
  let version = 0, calls = 0; const writes = []
  const load = createOverviewCache({ read: async () => null, readVersion: async () => version,
    write: async (_, payload, expected) => {
      if (version === 0) version++ // mutation between version read and INSERT
      if (expected !== version) return false
      writes.push(payload); return true
    } })
  const result = await load({ key: 'one', build: async () => ({ projects: [++calls] }) })
  assert.deepEqual(result.projects, [2]); assert.equal(writes.length, 1)
})

test('errors and partial results preserve complete snapshots and back off', async () => {
  for (const build of [async () => { throw Error('upstream failed') }, async () => ({ projects: [], partial: true })]) {
    const f = fixture(stale)
    await f.get({ build }); await Promise.all(f.jobs)
    assert.equal(f.writes.length, 0)
    assert.equal((await f.get({ build: () => assert.fail('backoff') })).refreshing, false)
    assert.equal((await f.get({ refresh: true, build })).refresh_failed, true)
  }
})

test('a partial cold result is returned but never cached', async () => {
  const f = fixture()
  assert.equal((await f.get({ build: async () => ({ projects: [], partial: true }) })).partial, true)
  assert.equal(f.writes.length, 0)
})

test('different keys do not share requests; runtimes without waitUntil await work', async () => {
  const f = fixture(stale)
  const result = await f.load({ key: 'two', build: async () => ({ projects: ['two'] }) })
  assert.deepEqual(result.projects, ['two'])
  assert.deepEqual(f.rows.get('one'), stale)
  const rebuilt = await f.load({ key: 'one', build: async () => ({ projects: ['awaited'] }) })
  assert.deepEqual(rebuilt.projects, ['awaited'])
})

test('continuous invalidation is bounded rather than returning invalidated data', async () => {
  const f = fixture(); let calls = 0
  await assert.rejects(f.get({ build: async () => { calls++; f.invalidate(); return { projects: [] } } }), { message: 'overview_cache_invalidated', statusCode: 503 })
  assert.equal(calls, 3); assert.equal(f.writes.length, 0)
})
