// Run after `pnpm build`; uses Wrangler's bundled local Worker runtime and in-memory D1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare } = wranglerRequire('miniflare')

test('production Worker serves both public OAuth discovery documents without a session', async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: resolve('.output/server/index.mjs'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'], fallthrough: true }],
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    bindings: { APP_SECRET: randomBytes(32).toString('hex') },
  })
  try {
    const db = await mf.getD1Database('DB')
    for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = await readFile(`migrations/${file}`, 'utf8')
      for (const statement of sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run()
      }
    }
    const origin = (await mf.ready).origin
    const get = async path => {
      const response = await mf.dispatchFetch(origin + path)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return response.json()
    }
    const resource = await get('/.well-known/oauth-protected-resource')
    assert.equal(resource.resource, `${origin}/api/mcp`)
    assert.deepEqual(resource.authorization_servers, [origin])
    const authorization = await get('/.well-known/oauth-authorization-server')
    assert.equal(authorization.issuer, origin)
    assert.equal(authorization.token_endpoint, `${origin}/api/mcp/oauth/token`)
    assert.deepEqual(authorization.code_challenge_methods_supported, ['S256'])
    assert.ok(authorization.grant_types_supported.includes('refresh_token'))
  } finally {
    await mf.dispose()
  }
})
