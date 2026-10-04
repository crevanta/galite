/* ===================================================================
 * 解除挂载 - 软删 project_data_source 行
 *
 * POST /api/projects/[projectKey]/data-sources/[id]
 *
 * 不影响 data_source_auth (其他项目可能仍在使用同一授权账号).
 * =================================================================== */

import { invalidateUserCache } from '../../../../utils/metrics-cache'
import { and, eq } from 'drizzle-orm'
import { project_data_source } from '../../../../database/schema'
import { loadOwnedProject } from '../../../../utils/project-access'
import { RecordStatus } from '../../../../utils/constants'

export default defineEventHandler(async (event) => {
  const projectKey = getRouterParam(event, 'projectKey')
  const idRaw = getRouterParam(event, 'id')
  const id = parseInt(idRaw, 10)
  if (!Number.isInteger(id) || id <= 0) return reqFail('id required')

  const db = await useDb(event)
  const { user, project } = await loadOwnedProject(event, db, projectKey)

  const now = Math.floor(Date.now() / 1000)
  await db.update(project_data_source)
    .set({ status: RecordStatus.DELETED, updated_at: now })
    .where(and(
      eq(project_data_source.id, id),
      eq(project_data_source.project_id, user.project_id),
      eq(project_data_source.union_id,   user.union_id),
      eq(project_data_source.project_key, project.project_key),
    ))

  await invalidateUserCache(db, user.project_id, user.union_id)

  return reqSuccess(null, 'unmounted')
})
