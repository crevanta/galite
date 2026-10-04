/* ===================================================================
 * 更新项目 - 字段白名单 (任意字段可选)
 *
 * POST /api/projects/[projectKey]/update
 * Body 子集: { name, description, logo_url, site_url, timezone,
 *             priority, realtime_dashboard }
 * =================================================================== */

import { invalidateUserCache } from '../../../utils/metrics-cache'
import { and, eq, ne } from 'drizzle-orm'
import { project_list } from '../../../database/schema'
import { loadOwnedProject } from '../../../utils/project-access'
import { RecordStatus } from '../../../utils/constants'
import { syncProjectMetaToGa4 } from '../../../utils/sync-ga4-property'
import { getJwtSecret, getSiteConfig } from '../../../utils/metrics-helpers'
import { getFirst } from '../../../utils/db'

const TEXT_FIELDS = ['name', 'description', 'logo_url', 'site_url', 'timezone']
const INT_FIELDS  = ['priority', 'realtime_dashboard']

/* ---- 收集白名单内的字段 patch ---- */
function buildPatch(body) {
  const patch = {}
  for (const f of TEXT_FIELDS) {
    if (body?.[f] !== undefined) patch[f] = String(body[f] ?? '').trim()
  }
  for (const f of INT_FIELDS) {
    if (body?.[f] !== undefined) {
      const v = parseInt(body[f], 10)
      if (!Number.isNaN(v)) patch[f] = v
    }
  }
  return patch
}

export default defineEventHandler(async (event) => {
  const projectKey = getRouterParam(event, 'projectKey')
  const body = await readBody(event)
  const db = await useDb(event)
  const { user, project } = await loadOwnedProject(event, db, projectKey)

  const patch = buildPatch(body)
  if (Object.keys(patch).length === 0) return reqFail('no fields to update')

  /* ===========================================================
     site_url 冲突预检 (仅当用户改了 site_url 且 force 不为 true)
     - 同 user 范围内查是否有别的 active 项目用相同 site_url
     - 命中 → 不更新 DB, 返回 requires_confirmation 让前端弹合并/强制保存对话框
     - body.force=true 跳过校验 (用户选"仅保存"时前端再次提交带 force)
     name 字段变更不需要校验, 因为多项目同名是合法的
     =========================================================== */
  const force = body?.force === true || body?.force === 'true'
  if (!force && patch.site_url !== undefined && patch.site_url && patch.site_url !== project.site_url) {
    const conflict = await getFirst(
      db.select({ project_key: project_list.project_key, name: project_list.name })
        .from(project_list)
        .where(and(
          eq(project_list.project_id, user.project_id),
          eq(project_list.union_id,   user.union_id),
          eq(project_list.site_url,   patch.site_url),
          eq(project_list.status,     RecordStatus.ACTIVE),
          ne(project_list.id,         project.id),  /* 排除自己 */
        ))
        .limit(1),
    )
    if (conflict) {
      return reqSuccess({
        requires_confirmation: 'url_conflict',
        target: {
          project_key: conflict.project_key,
          name: conflict.name,
        },
      }, 'url_conflict')
    }
  }

  patch.updated_at = Math.floor(Date.now() / 1000)
  await db.update(project_list).set(patch)
    .where(and(
      eq(project_list.id, project.id),
      eq(project_list.project_id, user.project_id),
      eq(project_list.union_id,   user.union_id),
    ))

  /* ===========================================================
     同步站点 meta 到挂载的 GA4 property — 同步 await 并把结果回传前端
     --
     行为:
       改 name → PATCH GA4 property displayName
       改 url  → PATCH GA4 webStream defaultUri
     --
     设计 (取代旧的 fire-and-forget + waitUntil):
       本地 DB 已落库 (真相源), GA4 是镜像. 用户需要知道镜像同步成没成 —
       所以这里 await 拿 { status } 回传, 前端据此分级提示
       (synced / 只读授权 / 限流 / 失效 / 失败).
       syncProjectMetaToGa4 全程不抛 (内部归类 + 外层 .catch 兜底) →
       本接口对 GA4 任何异常都恒返回 200, 不再把 GA4 故障误报成 503.
     =========================================================== */
  let ga4Sync = null
  if (patch.name !== undefined || patch.site_url !== undefined) {
    const jwtSecret = getJwtSecret(event)
    const siteConfig = getSiteConfig(event)
    ga4Sync = await syncProjectMetaToGa4(
      db,
      { project_id: user.project_id, union_id: user.union_id },
      projectKey,
      { name: patch.name, site_url: patch.site_url },
      jwtSecret,
      siteConfig,
    ).catch((e) => {
      console.warn('[ga4-sync] unexpected error:', e?.message || e)
      return { status: 'error' }
    })
  }

  await invalidateUserCache(db, user.project_id, user.union_id)

  return reqSuccess({ ga4_sync: ga4Sync }, 'updated')
})
