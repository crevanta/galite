/* ===================================================================
 * 数据源主动同步 — 完整拉取远端资源并与本地挂载对账
 *
 *  POST /api/data-sources/{id}/sync
 *
 *  跟 OAuth 回调内部 syncPropertiesAsProjects 的差异:
 *    OAuth 回调:  overwriteExisting=false → 已挂载 skip, 只 create 新的
 *    用户主动:    overwriteExisting=true  → 已挂载 update name/site_url/meta
 *                                          完整拉取后软删远端已消失的挂载及孤儿项目
 *
 *  安全:
 *    - 仅当 data_source_auth.status=1 (有效 token) 时同步, 99 直接拒绝引导重连
 *    - GA4 / GSC / Bing 均通过统一 provider 资源接口同步
 *    - 列举不完整时返回 sync_incomplete，禁止清理本地数据
 *    - 校验归属: (project_id, union_id, id) 三元组, 防越权
 *
 *  返回:
 *    { created, updated, removed, skipped, total }
 * =================================================================== */

import { and, eq } from 'drizzle-orm'
import { data_source_auth } from '../../../database/schema'
import { RecordStatus } from '../../../utils/constants'
import { syncResourcesFromAuth } from '../../../utils/auto-sync-projects'
import { invalidateProjectCache, invalidateUserCache } from '../../../utils/metrics-cache'

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const id = Number(event.context.params?.id)
  if (!Number.isInteger(id) || id <= 0) return reqFail('id required')

  const db = await useDb(event)

  /* ---- 校验归属 + 拉完整 auth 行 ---- */
  const authRow = await getFirst(
    db.select().from(data_source_auth).where(and(
      eq(data_source_auth.id, id),
      eq(data_source_auth.project_id, user.project_id),
      eq(data_source_auth.union_id, user.union_id),
    )).limit(1),
  )
  if (!authRow) return reqFail('not_found')

  /* ---- 状态检查: 失效 token 拒绝同步, 引导走重连. status=99 是 reauth, 跟其他流程一致 ---- */
  if (authRow.status === 99) {
    return reqFail('reauth_required', '账号授权已失效, 请先重新授权')
  }
  if (authRow.status !== RecordStatus.ACTIVE) {
    return reqFail('invalid_status', '该授权当前不可用')
  }

  /* ---- provider 白名单: GA4 + Search providers 均支持手动同步
          ga4 → 重拉 properties, overwriteExisting=true 覆盖 name/url
          gsc/bing → 重拉 sites，并在完整快照后做集合对账 ---- */
  if (!['ga4', 'gsc', 'bing'].includes(authRow.provider)) {
    return reqFail('provider_not_supported', '该 provider 暂不支持手动同步')
  }

  /* ---- 同步: ga4 覆盖更新, gsc dispatcher 内部按自身语义处理 ---- */
  const result = await syncResourcesFromAuth({
    db, event, authRow, user,
    overwriteExisting: true,
  })
  if (!result.complete) {
    return reqFail(result.error || 'sync_incomplete')
  }

  /* ---- 清用户 metrics 缓存: 项目名/URL 变了, dashboard 即时反映 ---- */
  await invalidateUserCache(db, user.project_id, user.union_id)
  for (const projectKey of result.affected_project_keys || []) {
    await invalidateProjectCache(db, user.project_id, projectKey)
  }

  return reqSuccess({
    created: result.created,
    updated: result.updated,
    removed: result.removed,
    skipped: result.skipped,
    total:   (result.properties || []).length,
  })
})
