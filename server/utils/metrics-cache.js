/* ===================================================================
 * metrics_cache 表读写
 *
 * cache_key 命名 (Plan.md §3):
 *   {provider}:{resource_id}:{period}[:{set}[:{dim}]]
 *
 * 设计:
 *   - readCache  命中 (未过期) 返回 { payload, from_cache: true }, 否则 null.
 *   - writeCache upsert 同 (project_id, cache_key) 行, 覆盖 payload + 续期.
 *
 * 实现哲学:
 *   - 失败不抛, 只 console.error: 缓存层不能阻塞业务调用.
 *   - payload 始终序列化为 JSON 字符串, 简单可靠 (longtext).
 * =================================================================== */

import { and, eq, like, lte, or, sql } from 'drizzle-orm'
import { metrics_cache } from '../database/schema'
import { getFirst } from './db'
import { advanceOverviewVersion } from './overview-cache-version'

export const METRICS_CACHE_RETENTION_SECONDS = 24 * 60 * 60
export const CONSUMER_STALE_TTL_SECONDS = METRICS_CACHE_RETENTION_SECONDS

function parsePayload(row) {
  const payload = JSON.parse(row.payload)
  return payload && typeof payload === 'object' ? payload : {}
}

export async function readCacheEntry(db, projectId, cacheKey, options = {}) {
  if (!db || !projectId || !cacheKey) return null
  try {
    const row = await getFirst(
      db.select({
        payload: metrics_cache.payload,
        expires_at: metrics_cache.expires_at,
        updated_at: metrics_cache.updated_at,
      })
        .from(metrics_cache)
        .where(and(
          eq(metrics_cache.project_id, projectId),
          eq(metrics_cache.cache_key, cacheKey),
        ))
        .limit(1),
    )
    if (!row) return null

    const now = Math.floor(Date.now() / 1000)
    const expiresAt = Number(row.expires_at) || 0
    const retainUntil = (Number(row.updated_at) || 0) + METRICS_CACHE_RETENTION_SECONDS
    if (retainUntil <= now) return null

    const staleTtlSeconds = Math.max(0, Number(options.staleTtlSeconds) || 0)
    const staleUntil = Math.min(expiresAt + staleTtlSeconds, retainUntil)
    if (expiresAt <= now && (!staleTtlSeconds || staleUntil <= now)) return null

    return {
      payload: parsePayload(row),
      state: expiresAt > now ? 'hit' : 'stale',
      expiresAt,
      updatedAt: Number(row.updated_at) || 0,
    }
  } catch (err) {
    console.error('[metrics-cache] readCache error:', err?.message || err)
    return null
  }
}

/* ---- 读: dash 默认只吃新鲜缓存; v1/MCP 可显式允许 stale ---- */
export async function readCache(db, projectId, cacheKey, options = {}) {
  const entry = await readCacheEntry(db, projectId, cacheKey, {
    staleTtlSeconds: options.allowStale ? options.staleTtlSeconds : 0,
  })
  if (!entry || (entry.state !== 'hit' && !options.allowStale)) return null
  return {
    ...entry.payload,
    from_cache: true,
    cache_state: entry.state,
    cache_expires_at: entry.expiresAt,
  }
}

export function staleCacheOptions(event, options = {}) {
  const authSource = event?.context?.user?.auth_source || ''
  if (authSource !== 'api_key' && authSource !== 'mcp_oauth') return {}
  return {
    allowStale: true,
    staleTtlSeconds: Number(options.staleTtlSeconds) || CONSUMER_STALE_TTL_SECONDS,
  }
}

/* ---- 写: upsert (project_id + cache_key 唯一索引) ---- */
export async function writeCache(db, projectId, cacheKey, payload, ttlSeconds) {
  if (!db || !projectId || !cacheKey) return
  try {
    const now = Math.floor(Date.now() / 1000)
    const ttl = Math.min(
      METRICS_CACHE_RETENTION_SECONDS,
      Math.max(1, Number(ttlSeconds) || 0),
    )
    const expiresAt = now + ttl
    const json = JSON.stringify(payload)

    await db.insert(metrics_cache).values({
      project_id: projectId,
      cache_key: cacheKey,
      payload: json,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    }).onConflictDoUpdate({
      target: [metrics_cache.project_id, metrics_cache.cache_key],
      set: { payload: json, expires_at: expiresAt, updated_at: now },
    })
  } catch (err) {
    console.error('[metrics-cache] writeCache error:', err?.message || err)
  }
}

/* ---- key 拼接小工具 (避免各 handler 各自拼错) ---- */
export function buildCacheKey(parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(':')
}

function affectedRows(result) {
  const head = Array.isArray(result) ? result[0] : result
  return Number(head?.affectedRows ?? head?.rowsAffected ?? head?.changes ?? head?.meta?.changes ?? 0)
}

export async function claimCacheRefresh(db, projectId, cacheKey, expectedExpiresAt, leaseSeconds = 30) {
  if (!db || !projectId || !cacheKey) return false
  try {
    const now = Math.floor(Date.now() / 1000)
    const retainCutoff = now - METRICS_CACHE_RETENTION_SECONDS
    const result = await db.execute(sql`
      UPDATE metrics_cache
      SET expires_at = MIN(
        ${now + Math.max(1, Number(leaseSeconds) || 30)},
        updated_at + ${METRICS_CACHE_RETENTION_SECONDS}
      )
      WHERE project_id = ${projectId}
        AND cache_key = ${cacheKey}
        AND expires_at = ${Number(expectedExpiresAt) || 0}
        AND updated_at > ${retainCutoff}
    `)
    return affectedRows(result) > 0
  } catch (err) {
    console.error('[metrics-cache] claimCacheRefresh error:', err?.message || err)
    return false
  }
}

/* ---- 物理清理: payload 最后写入满 24 小时即删除 ---- */
export async function purgeExpiredMetricsCache(db, now = Math.floor(Date.now() / 1000)) {
  if (!db) return 0
  const cutoff = Number(now) - METRICS_CACHE_RETENTION_SECONDS
  const result = await db.delete(metrics_cache)
    .where(lte(metrics_cache.updated_at, cutoff))
  return affectedRows(result)
}

/* ===================================================================
 *  按用户清缓存 (授权变更后必调, 避免旧 0 值缓存)
 *
 *  cache_key 形态 (provider-agnostic 匹配):
 *    - 用户级:   ga4:user:{union_id}:...           ↘
 *                gsc:overview:user:{union_id}:...  ↗ 共同特征: :user:{union_id}:
 *    - 项目级:   ga4:project:{project_key}:...     ↘
 *                gsc:project:{project_key}:...     ↗ 共同特征: :project:{project_key}:
 *
 *  踩坑记录: 旧实现只 LIKE 'ga4:user:%' 漏清 GSC overview 缓存,
 *           导致用户断开 GSC 后切回 /projects 还能看到旧 GSC 数据.
 *           改用中段匹配 '%:user:{union_id}:%' 覆盖任意 provider.
 *
 *  用户级失效必须成功: 版本更新失败时向调用方返回错误, 防止静默保留旧总览。
 * =================================================================== */
export async function invalidateUserCache(db, projectId, unionId) {
  if (!db || !projectId || !unionId) return
  // D1 executes the version change and deletion in one transaction. An old
  // in-flight rebuild cannot write after this batch, even on another Worker.
  await db.batch([
    advanceOverviewVersion(db, projectId),
    db.delete(metrics_cache).where(and(
      eq(metrics_cache.project_id, projectId),
      like(metrics_cache.cache_key, `%:user:${unionId}:%`),
    )),
  ])
}

/* ---- 按项目清缓存 (覆盖 ga4 + gsc 项目级 cache) ---- */
export async function invalidateProjectCaches(db, projectId, projectKeys) {
  const keys = [...new Set((Array.isArray(projectKeys) ? projectKeys : [projectKeys]).filter(Boolean))]
  if (!db || !projectId || !keys.length) return
  try {
    for (let offset = 0; offset < keys.length; offset += 80) {
      const chunk = keys.slice(offset, offset + 80)
      await db.delete(metrics_cache).where(and(
        eq(metrics_cache.project_id, projectId),
        or(...chunk.map((key) => like(metrics_cache.cache_key, `%:project:${key}:%`))),
      ))
    }
  } catch (err) {
    console.error('[metrics-cache] invalidateProjectCaches error:', err?.message || err)
  }
}

export async function invalidateProjectCache(db, projectId, projectKey) {
  return invalidateProjectCaches(db, projectId, [projectKey])
}
