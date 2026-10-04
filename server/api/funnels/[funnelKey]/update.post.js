/* ===================================================================
 * 更新漏斗 - 字段白名单 (name / steps 任选, 至少一个)
 *
 * POST /api/funnels/{funnelKey}/update
 * Body: { name?, steps? }
 *
 * 更新 steps 时强制全量替换 (不做单步增量, 简化语义).
 * 改 steps 同时清除该漏斗的 metrics_cache (避免旧结果误读).
 * =================================================================== */

import { and, eq } from 'drizzle-orm'
import { project_funnel, metrics_cache } from '../../../database/schema'
import { loadOwnedFunnel } from '../../../utils/funnel-access'
import { normalizeSteps, parseSteps, shapeStep, FUNNEL_NAME_MAX } from '../../../utils/funnel-steps'

/* ---- 清缓存: 该 funnel_key 下所有 period 的缓存行 ---- */
async function invalidateFunnelCache(db, projectId, funnelKey) {
  try {
    const { sql } = await import('drizzle-orm')
    await db.run(sql`
      DELETE FROM metrics_cache
      WHERE project_id = ${projectId}
        AND cache_key LIKE ${'ga4:funnel:' + funnelKey + ':%'}
    `)
  } catch (err) {
    /* 缓存清失败不阻塞更新 */
    console.error('[funnel/update] invalidate cache error:', err?.message || err)
  }
}

export default defineEventHandler(async (event) => {
  const funnelKey = getRouterParam(event, 'funnelKey')
  const body = await readBody(event)
  const db = await useDb(event)
  const { user, funnel } = await loadOwnedFunnel(event, db, funnelKey)

  const patch = {}
  let stepsChanged = false

  /* ---- name ---- */
  if (body?.name !== undefined) {
    patch.name = String(body.name || '').trim().slice(0, FUNNEL_NAME_MAX)
  }

  /* ---- steps ---- */
  if (body?.steps !== undefined) {
    const r = normalizeSteps(body.steps)
    if (r.error) return reqFail(r.error)
    patch.steps_config = JSON.stringify(r.steps)
    stepsChanged = true
  }

  if (Object.keys(patch).length === 0) return reqFail('no_fields_to_update')

  patch.updated_at = Math.floor(Date.now() / 1000)
  await db.update(project_funnel).set(patch)
    .where(and(
      eq(project_funnel.id, funnel.id),
      eq(project_funnel.project_id, user.project_id),
      eq(project_funnel.union_id,   user.union_id),
    ))

  /* ---- 改了步骤就清缓存 ---- */
  if (stepsChanged) {
    await invalidateFunnelCache(db, user.project_id, funnel.funnel_key)
  }

  /* ---- 返回更新后的最新形态 (前端拿来 patch list 单条) ---- */
  const steps = parseSteps(patch.steps_config || funnel.steps_config).map(shapeStep)
  return reqSuccess({
    funnel_key: funnel.funnel_key,
    project_key: funnel.project_key,
    name: patch.name !== undefined ? patch.name : (funnel.name || ''),
    step_count: steps.length,
    steps,
    updated_at: patch.updated_at,
  })
})
