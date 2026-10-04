import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { drizzle } from 'drizzle-orm/d1'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare } = wranglerRequire('miniflare')
const { build } = wranglerRequire('esbuild')

test('persistent D1 versions fence cold builds across separate request pools and cache purges', async () => {
  const dir = await mkdtemp(resolve('node_modules/.overview-cache-test-'))
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-08-01', d1Databases: ['DB'] })
  try {
    const outfile = resolve(dir, 'cache.mjs')
    await build({ stdin: { contents: `
      export * from './server/utils/overview-cache-version.js';
      export * from './server/utils/overview-cache-core.js';
      export * from './server/utils/metrics-cache.js';`, resolveDir: process.cwd() },
      outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm' })
    const api = await import(pathToFileURL(outfile).href)
    const binding = await mf.getD1Database('DB')
    for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of (await readFile(`migrations/${file}`, 'utf8')).split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
        await binding.prepare(statement).run()
      }
    }
    const dbA = drizzle(binding), dbB = drizzle(binding)
    const key = 'ga4:user:owner:all:7days:overview'
    const options = db => ({
      read: key => api.readCacheEntry(db, 'site', key, { staleTtlSeconds: 86400 }),
      readVersion: () => api.readOverviewVersion(db, 'site'),
      write: (key, payload, version) => api.writeOverviewCache(db, 'site', key, payload, 300, version),
    })
    const loadA = api.createOverviewCache(options(dbA)), loadB = api.createOverviewCache(options(dbB))
    let release, started
    const ready = new Promise(resolve => { started = resolve })
    const oldBuild = new Promise(resolve => { release = resolve })
    const old = loadA({ key, build: async () => { started(); return oldBuild } })
    await ready
    assert.equal(await api.readOverviewVersion(dbB, 'site'), 0)
    await api.invalidateUserCache(dbB, 'site', 'owner')
    assert.equal(await api.readOverviewVersion(dbA, 'site'), 1)
    const fresh = await loadB({ key, build: async () => ({ projects: ['current'] }) })
    release({ projects: ['deleted'] })
    assert.deepEqual((await old).projects, fresh.projects)
    assert.deepEqual((await api.readCacheEntry(dbB, 'site', key)).payload.projects, ['current'])
    // Also exercise the exact read-version / invalidation / INSERT race in SQL.
    await api.invalidateUserCache(dbB, 'site', 'owner')
    assert.equal(await api.writeOverviewCache(dbA, 'site', key, { projects: ['stale'] }, 300, 1), false)
    assert.equal(await api.readCacheEntry(dbA, 'site', key), null)
    assert.equal(await api.writeOverviewCache(dbA, 'site', key, { projects: ['valid'] }, 300, 2), true)
    await api.purgeExpiredMetricsCache(dbB, Math.floor(Date.now() / 1000) + 86401)
    assert.equal(await api.readOverviewVersion(dbB, 'site'), 2)
    assert.equal(await api.writeOverviewCache(dbA, 'site', key, { projects: ['stale'] }, 300, 0), false)
    assert.equal(await api.readOverviewVersion(dbA, 'other-site'), 0)
    assert.equal(await api.writeOverviewCache(dbA, 'other-site', key, { projects: ['other'] }, 300, 0), true)
  } finally {
    await mf.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
