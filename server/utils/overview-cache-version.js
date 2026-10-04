import { eq, sql } from 'drizzle-orm'
import { metrics_cache_versions } from '../database/schema'

export async function readOverviewVersion(db, projectId) {
  const rows = await db.select({ version: metrics_cache_versions.version })
    .from(metrics_cache_versions).where(eq(metrics_cache_versions.project_id, projectId)).limit(1)
  return Number(rows[0]?.version || 0)
}

// Keep the version even when there are no cached rows, including after cache GC.
export function advanceOverviewVersion(db, projectId) {
  return db.insert(metrics_cache_versions).values({ project_id: projectId, version: 1 })
    .onConflictDoUpdate({
      target: metrics_cache_versions.project_id,
      set: { version: sql`${metrics_cache_versions.version} + 1` },
    })
}

export async function writeOverviewCache(db, projectId, cacheKey, payload, ttlSeconds, expectedVersion) {
  const now = Math.floor(Date.now() / 1000)
  const result = await db.run(sql`
    INSERT INTO metrics_cache (project_id, cache_key, payload, expires_at, created_at, updated_at)
    SELECT ${projectId}, ${cacheKey}, ${JSON.stringify(payload)}, ${now + ttlSeconds}, ${now}, ${now}
    WHERE COALESCE((SELECT version FROM metrics_cache_versions WHERE project_id = ${projectId}), 0) = ${expectedVersion}
    ON CONFLICT(project_id, cache_key) DO UPDATE SET
      payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at
  `)
  return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0
}
