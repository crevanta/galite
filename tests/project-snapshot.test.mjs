import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectSnapshotCache, snapshotOwner } from '../app/utils/project-snapshot.js'

function fixture() {
  const data = new Map()
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
  let time = 100000000
  const cache = createProjectSnapshotCache(storage, () => time)
  return { data, cache, advance: ms => { time += ms } }
}
const payload = { period: '28days', cached_at: 100000, projects: [{ project_key: 'one', metrics: { screenPageViews: 123 } }], totals: {} }

test('synchronously restores metrics by account, period and provider without a request', () => {
  const { cache } = fixture()
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  cache.write('owner', '28days', 'search', { ...payload, totals: { clicks: 7 } }, cache.revision())
  assert.equal(cache.read('owner', '28days').ga4.projects[0].metrics.screenPageViews, 123)
  assert.equal(cache.read('owner', '28days').search.totals.clicks, 7)
  assert.equal(cache.read('other', '28days'), null)
  assert.equal(cache.read('owner', '7days'), null)
  assert.equal(cache.read('', '28days'), null)
  assert.notEqual(snapshotOwner({ email: 'a@example.com', union_id: 'owner' }), snapshotOwner({ email: 'b@example.com', union_id: 'owner' }))
})

test('age is based on source data, so repeated visits cannot keep old data alive', () => {
  const { cache, advance } = fixture()
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  advance(23 * 3600000)
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  assert.ok(cache.read('owner', '28days'))
  advance(3600000)
  assert.equal(cache.read('owner', '28days'), null)
})

test('logout or mutations clear all periods and prevent in-flight results repopulating storage', () => {
  const { cache } = fixture()
  const revision = cache.revision()
  cache.write('owner', '28days', 'ga4', payload, revision)
  cache.clear()
  cache.write('owner', '28days', 'ga4', payload, revision)
  assert.equal(cache.read('owner', '28days'), null)
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  assert.ok(cache.read('owner', '28days'))
})

test('retention is bounded and top-level non-display fields are discarded', () => {
  const { cache, data } = fixture()
  for (let n = 0; n < 10; n++) {
    cache.write('owner', `${n}days`, 'ga4', { ...payload, period: `${n}days`, access_token: 'must-not-persist' }, cache.revision())
  }
  assert.equal(cache.read('owner', '0days'), null)
  assert.ok(cache.read('owner', '9days'))
  assert.ok(![...data.values()].join('').includes('must-not-persist'))
})

test('corrupt or unavailable local storage cannot break the dashboard', () => {
  for (const raw of ['broken JSON', '{}', '[null]']) {
    const cache = createProjectSnapshotCache({ getItem: () => raw })
    assert.equal(cache.read('owner', '28days'), null)
  }
  const denied = () => { throw Error('Storage disabled') }
  const cache = createProjectSnapshotCache({ getItem: denied, setItem: denied, removeItem: denied })
  assert.equal(cache.read('owner', '28days'), null)
  assert.doesNotThrow(() => cache.write('owner', '28days', 'ga4', payload, cache.revision()))
  assert.doesNotThrow(() => cache.clear())
})

test('partial responses do not replace a complete browser snapshot', () => {
  const { cache } = fixture()
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  cache.write('owner', '28days', 'ga4', { ...payload, projects: [], partial: true }, cache.revision())
  assert.equal(cache.read('owner', '28days').ga4.projects.length, 1)
})

test('quota failure while clearing still removes snapshots and fences late responses', () => {
  const data = new Map(); let full = false
  const storage = { getItem: key => data.get(key), removeItem: key => data.delete(key),
    setItem: (key, value) => { if (full) throw Error('quota'); data.set(key, value) } }
  const cache = createProjectSnapshotCache(storage, () => 100000000)
  cache.write('owner', '28days', 'ga4', payload, cache.revision())
  const before = cache.revision()
  full = true; cache.clear(); full = false
  const otherInstance = createProjectSnapshotCache(storage, () => 100000000)
  otherInstance.write('owner', '28days', 'ga4', payload, before)
  assert.equal(otherInstance.read('owner', '28days'), null)
})
