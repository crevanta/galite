import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { drizzle } from 'drizzle-orm/d1'

// Reuse Wrangler's build/runtime dependencies; no production dependencies are added.
const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare } = wranglerRequire('miniflare')
const { build } = wranglerRequire('esbuild')

test('D1 cache invalidation and refresh leases execute against SQLite', async () => {
  const dir = await mkdtemp(resolve('node_modules/.cache-test-'))
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-08-01',
    d1Databases: ['DB'],
  })
  try {
    const output = resolve(dir, 'metrics-cache.mjs')
    await build({ entryPoints: ['server/utils/metrics-cache.js'], outfile: output,
      bundle: true, packages: 'external', platform: 'node', format: 'esm' })
    const { invalidateUserCache, claimCacheRefresh } = await import(pathToFileURL(output).href)
    const binding = await mf.getD1Database('DB')
    for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of (await readFile(`migrations/${file}`, 'utf8')).split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
        await binding.prepare(statement).run()
      }
    }
    const db = drizzle(binding)
    const now = Math.floor(Date.now() / 1000)
    const insert = async (project, key) => binding.prepare(
      'INSERT INTO metrics_cache (project_id,cache_key,payload,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).bind(project, key, '{}', now - 10, now, now).run()
    await insert('site', 'ga4:overview:user:owner:7days')
    await insert('site', 'gsc:overview:user:owner:7days')
    await insert('site', 'ga4:overview:user:other:7days')
    await insert('other-site', 'ga4:overview:user:owner:7days')
    await invalidateUserCache(db, 'site', 'owner')
    const { results } = await binding.prepare('SELECT project_id,cache_key FROM metrics_cache ORDER BY project_id').all()
    assert.deepEqual(results, [
      { project_id: 'other-site', cache_key: 'ga4:overview:user:owner:7days' },
      { project_id: 'site', cache_key: 'ga4:overview:user:other:7days' },
    ])

    const key = 'ga4:project:demo:7days'
    await insert('site', key)
    assert.equal(await claimCacheRefresh(db, 'other-site', key, now - 10), false)
    assert.equal(await claimCacheRefresh(db, 'site', key, now - 10), true)
    assert.equal(await claimCacheRefresh(db, 'site', key, now - 10), false)
    const row = await binding.prepare('SELECT expires_at FROM metrics_cache WHERE project_id=? AND cache_key=?').bind('site', key).first()
    assert.ok(row.expires_at > now)
  } finally {
    await mf.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
