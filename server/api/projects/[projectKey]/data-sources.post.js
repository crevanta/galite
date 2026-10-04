/* ===================================================================
 * 挂载数据源到项目 (idempotent upsert)
 *
 * POST /api/projects/[projectKey]/data-sources
 * Body: { auth_id, resource_id, resource_label?, resource_meta?, realtime_dashboard? }
 *
 * 校验:
 *   1) auth 行属于当前 user (project_id + union_id + id)
 *   2) auth.status === 1 (失效授权拒绝挂载)
 *   3) 同 (project_key, provider, resource_id) 已挂过 -> 直接返回原行
 * =================================================================== */

import { invalidateUserCache } from '../../../utils/metrics-cache'
import { and, eq } from 'drizzle-orm'
import { project_data_source, data_source_auth } from '../../../database/schema'
import { loadOwnedProject } from '../../../utils/project-access'
import { RecordStatus } from '../../../utils/constants'

/* ---- 输入校验与归一化 ---- */
function normalize(body) {
  const authId = parseInt(body?.auth_id, 10)
  const resourceId = String(body?.resource_id || '').trim()
  if (!Number.isInteger(authId) || authId <= 0) return { error: 'auth_id required' }
  if (!resourceId) return { error: 'resource_id required' }
  return {
    auth_id: authId,
    resource_id: resourceId.slice(0, 255),
    resource_label: String(body?.resource_label || '').trim().slice(0, 255),
    resource_meta: body?.resource_meta ? JSON.stringify(body.resource_meta) : '{}',
    realtime_dashboard: body?.realtime_dashboard === 0 ? 0 : 1,
  }
}

/* ---- 校验 auth 归属 + 状态 ---- */
async function verifyAuth(db, user, authId) {
  const row = await getFirst(
    db.select().from(data_source_auth)
      .where(and(
        eq(data_source_auth.id, authId),
        eq(data_source_auth.project_id, user.project_id),
        eq(data_source_auth.union_id,   user.union_id),
      ))
      .limit(1),
  )
  if (!row) return { error: 'auth not found' }
  if (row.status !== RecordStatus.ACTIVE) return { error: 'auth not active' }
  return { auth: row }
}

/* ---- 已挂过 -> 同 (project_key, provider, resource_id, status=1) ---- */
async function findExisting(db, user, projectKey, provider, resourceId) {
  return getFirst(
    db.select().from(project_data_source)
      .where(and(
        eq(project_data_source.project_id, user.project_id),
        eq(project_data_source.union_id,   user.union_id),
        eq(project_data_source.project_key, projectKey),
        eq(project_data_source.provider,    provider),
        eq(project_data_source.resource_id, resourceId),
        eq(project_data_source.status,      RecordStatus.ACTIVE),
      ))
      .limit(1),
  )
}

/* ---- 出参整形 ---- */
function shape(row) {
  let meta = {}
  try { meta = JSON.parse(row.resource_meta || '{}') } catch {}
  return {
    id: row.id,
    provider: row.provider,
    auth_id: row.auth_id,
    resource_id: row.resource_id,
    resource_label: row.resource_label || '',
    resource_meta: meta,
    realtime_dashboard: row.realtime_dashboard ?? 1,
    created_at: row.created_at,
  }
}

export default defineEventHandler(async (event) => {
  const projectKey = getRouterParam(event, 'projectKey')
  const body = await readBody(event)
  const db = await useDb(event)
  const { user, project } = await loadOwnedProject(event, db, projectKey)

  const input = normalize(body)
  if (input.error) return reqFail(input.error)

  const verified = await verifyAuth(db, user, input.auth_id)
  if (verified.error) return reqFail(verified.error)
  const provider = verified.auth.provider

  /* ---- idempotent: 已挂过直接返回原行 ---- */
  const existing = await findExisting(db, user, project.project_key, provider, input.resource_id)
  if (existing) return reqSuccess(shape(existing))

  /* ---- 写入新行 ---- */
  const now = Math.floor(Date.now() / 1000)
  await db.insert(project_data_source).values({
    project_id: user.project_id,
    union_id: user.union_id,
    project_key: project.project_key,
    provider,
    auth_id: input.auth_id,
    resource_id: input.resource_id,
    resource_label: input.resource_label,
    resource_meta: input.resource_meta,
    realtime_dashboard: input.realtime_dashboard,
    status: RecordStatus.ACTIVE,
    created_at: now,
    updated_at: now,
  })

  const row = await findExisting(db, user, project.project_key, provider, input.resource_id)
  await invalidateUserCache(db, user.project_id, user.union_id)

  return reqSuccess(shape(row))
})
