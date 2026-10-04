// Run after pnpm build. Exercises actual auth, mutations, and overview HTTP routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
const require = createRequire(import.meta.url)
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))('miniflare')

test('built Worker caches both overviews and invalidates them after project edits', async () => {
  const mf = new Miniflare({ modules: true, scriptPath: resolve('.output/server/index.mjs'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'], fallthrough: true }],
    compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], bindings: { APP_SECRET: randomBytes(32).toString('hex') } })
  try {
    const db = await mf.getD1Database('DB')
    for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
      for (const sql of (await readFile(`migrations/${file}`, 'utf8')).split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(sql).run()
      }
    }
    const origin = (await mf.ready).origin
    let cookie = ''
    const request = async (path, body) => {
      const response = await mf.dispatchFetch(origin + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      })
      assert.equal(response.status, 200, path)
      const session = response.headers.get('set-cookie')?.match(/ct_token=[^;]+/)
      if (session) cookie = session[0]
      const result = await response.json()
      assert.equal(result.code, 200, `${path}: ${result.msg}`)
      return result.data
    }
    await request('/api/setup/initialize', { email: 'test@example.com', password: 'CacheTestPassword42!', password_confirmation: 'CacheTestPassword42!' })
    assert.ok(cookie)
    for (const path of ['/api/metrics/overview', '/api/metrics/overview/search']) {
      const first = await request(`${path}?period=7days`)
      assert.ok(first.cached_at > 0)
      assert.equal(first.from_cache, undefined)
      const cached = await request(`${path}?period=7days`)
      assert.equal(cached.from_cache, true)
      assert.equal(cached.cached_at, first.cached_at)
      const forced = await request(`${path}?period=7days&refresh=1`)
      assert.equal(forced.from_cache, undefined)
    }
    const project = await request('/api/projects/create', { name: 'Before', site_url: 'https://example.com' })
    await request(`/api/projects/${project.project_key}/update`, { name: 'After' })
    const rows = await db.prepare('SELECT version FROM metrics_cache_versions').all()
    assert.equal(rows.results[0].version, 1)
    for (const path of ['/api/metrics/overview', '/api/metrics/overview/search']) {
      assert.equal((await request(`${path}?period=7days`)).from_cache, undefined)
    }
  } finally { await mf.dispose() }
})
