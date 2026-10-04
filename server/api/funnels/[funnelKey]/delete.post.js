/* ===================================================================
 * 软删漏斗 - status=97
 *
 * POST /api/funnels/{funnelKey}/delete
 *
 * 不需要返回 data, 只 ack. 同时清该漏斗的缓存行 (避免重新创建同名时残留).
 * =================================================================== */

import { and, eq } from 'drizzle-orm'
import { project_funnel } from '../../../database/schema'
import { loadOwnedFunnel } from '../../../utils/funnel-access'
import { RecordStatus } from '../../../utils/constants'

async function invalidateFunnelCache(db, projectId, funnelKey) {
  try {
    const { sql } = await import('drizzle-orm')
    await db.run(sql`
      DELETE FROM metrics_cache
      WHERE project_id = ${projectId}
        AND cache_key LIKE ${'ga4:funnel:' + funnelKey + ':%'}
    `)
  } catch (err) {
    console.error('[funnel/delete] invalidate cache error:', err?.message || err)
  }
}

export default defineEventHandler(async (event) => {
  const funnelKey = getRouterParam(event, 'funnelKey')
  const db = await useDb(event)
  const { user, funnel } = await loadOwnedFunnel(event, db, funnelKey)

  const now = Math.floor(Date.now() / 1000)
  await db.update(project_funnel)
    .set({ status: RecordStatus.DELETED, updated_at: now })
    .where(and(
      eq(project_funnel.id, funnel.id),
      eq(project_funnel.project_id, user.project_id),
      eq(project_funnel.union_id,   user.union_id),
    ))

  await invalidateFunnelCache(db, user.project_id, funnel.funnel_key)

  return reqSuccess(null, 'deleted')
})
