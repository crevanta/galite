/* ===================================================================
 *  远端资源同步与集合对账
 *
 *  调用时机: OAuth 回调、API Key 接入、用户主动同步。
 *
 *  设计:
 *    1. 完整拉取 listProperties -> 远端资源快照
 *    2. 一次读取本地快照，在内存里生成待 upsert 的项目与挂载
 *    3. 完整快照成功后做差集，软删远端已消失的挂载与孤儿项目
 *
 *  铁律:
 *    - 远端列举失败或响应不完整时 complete=false，绝不执行清理
 *    - 不污染 schema, 全部走现有字段
 *    - resource_id 与 mount API 完全一致 ("properties/xxx") 保证去重
 * =================================================================== */

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { project_list, project_data_source } from '../database/schema'
import { getFirst, runInBatches, selectInBatches } from './db'
import { generateProjectKey } from './ids'
import { providerOf } from './providers'
import { getProviderCredential } from './data-source-token'
import { RecordStatus } from './constants'
import { getAppSecret } from './self-hosted'
import { publicSyncErrorCode } from './google-api-error'

/* ===== 取 properties ===== */
async function fetchProperties(db, authRow, event) {
  const provider = providerOf(authRow.provider)
  const jwtSecret = getAppSecret(event)
  const credential = await getProviderCredential(db, authRow, jwtSecret, event.context.siteConfig)
  return provider.listProperties({ accessToken: credential, apiKey: credential })
}

/* ===================================================================
 *  远端资源集合对账
 *
 *  安全边界:
 *    - caller 只能在 provider 完整列举成功后调用
 *    - 远端不存在、本地仍活跃的挂载统一软删
 *    - 项目失去最后一个活跃数据源后才软删
 *    - D1 不支持交互式事务；先软删挂载，再按当前活跃挂载判定孤儿项目
 *
 *  关键区别: “远端成功返回空数组”是有效快照，可以清空；
 *            “远端请求失败”不是空数组，caller 必须直接返回 complete=false。
 * =================================================================== */
async function reconcileRemovedResources(db, user, authRow, resources, now, prefetchedRows = null) {
  const remoteIds = new Set(
    (Array.isArray(resources) ? resources : [])
      .map((resource) => String(resource?.id || '').trim())
      .filter(Boolean),
  )

  const localRows = Array.isArray(prefetchedRows)
    ? prefetchedRows
    : await db.select({
        id: project_data_source.id,
        project_key: project_data_source.project_key,
        resource_id: project_data_source.resource_id,
      })
        .from(project_data_source)
        .where(and(
          eq(project_data_source.project_id, user.project_id),
          eq(project_data_source.union_id, user.union_id),
          eq(project_data_source.provider, authRow.provider),
          eq(project_data_source.auth_id, authRow.id),
          eq(project_data_source.status, RecordStatus.ACTIVE),
        ))

  const removedRows = localRows.filter((row) => !remoteIds.has(String(row.resource_id || '')))
  if (!removedRows.length) return { removed: 0, affectedProjectKeys: [] }

  const removedIds = removedRows.map((row) => row.id)
  await runInBatches(removedIds, (ids) => db.update(project_data_source)
    .set({ status: RecordStatus.DELETED, updated_at: now })
    .where(and(
      eq(project_data_source.project_id, user.project_id),
      eq(project_data_source.union_id, user.union_id),
      eq(project_data_source.auth_id, authRow.id),
      inArray(project_data_source.id, ids),
    )))

  const affectedProjectKeys = [...new Set(
    removedRows.map((row) => row.project_key).filter(Boolean),
  )]
  const remainingRows = await selectInBatches(affectedProjectKeys, (keys) => db.select({
    project_key: project_data_source.project_key,
  }).from(project_data_source).where(and(
    eq(project_data_source.project_id, user.project_id),
    eq(project_data_source.union_id, user.union_id),
    inArray(project_data_source.project_key, keys),
    eq(project_data_source.status, RecordStatus.ACTIVE),
  )))
  const remainingKeys = new Set(remainingRows.map((row) => row.project_key))
  const orphanKeys = affectedProjectKeys.filter((key) => !remainingKeys.has(key))
  await runInBatches(orphanKeys, (keys) => db.update(project_list)
    .set({ status: RecordStatus.DELETED, updated_at: now })
    .where(and(
      eq(project_list.project_id, user.project_id),
      eq(project_list.union_id, user.union_id),
      inArray(project_list.project_key, keys),
      eq(project_list.status, RecordStatus.ACTIVE),
    )))

  return { removed: removedRows.length, affectedProjectKeys }
}

/* ===== 生成不重复的 project_key (碰撞重试 1 次) =====
 *  base62 字母风格 (URL 可见), 导出给 create / create-with-ga4 复用, 单一真相源.
 */
export async function pickProjectKey(db, projectId) {
  for (let i = 0; i < 2; i++) {
    const candidate = generateProjectKey()
    const exists = await getFirst(
      db.select({ id: project_list.id }).from(project_list)
        .where(and(eq(project_list.project_id, projectId), eq(project_list.project_key, candidate)))
        .limit(1),
    )
    if (!exists) return candidate
  }
  return null
}

/* ===== 写一行 project_list =====
 *  property 只用 label / meta.* 等纯数据字段, 故 auto-sync 与
 *  手动创建 (create-with-ga4) 共用.
 */
function projectRow(user, projectKey, property, now) {
  const name     = String(property?.label || property?.meta?.property_id || '').slice(0, 100) || 'GA4 Property'
  const timezone = String(property?.meta?.timezone || '').slice(0, 64)
  const siteUrl  = String(property?.meta?.website_uri || '').slice(0, 500)
  return {
    project_id: user.project_id,
    union_id: user.union_id,
    project_key: projectKey,
    name,
    description: '',
    site_url: siteUrl,
    logo_url: '',
    timezone,
    priority: 0,
    status: RecordStatus.ACTIVE,
    created_at: now,
    updated_at: now,
  }
}

export async function insertProject(db, user, projectKey, property, now) {
  await db.insert(project_list).values(projectRow(user, projectKey, property, now))
}

/* ===== 写一行 project_data_source (挂载) =====
 *  resource_id / resource_label / meta 全部从 property 取, 与
 *  auto-sync 路径完全一致, 保证 (provider, resource_id) 唯一约束兜底.
 */
function mountRow(user, projectKey, authRow, property, now) {
  const meta = {
    display_name:  property?.label || '',
    account_id:    property?.meta?.account_id || '',
    account_name:  property?.meta?.account_name || '',
    create_time:   property?.meta?.create_time || '',
    timezone:      property?.meta?.timezone || '',
    currency:      property?.meta?.currency || '',
  }
  return {
    project_id: user.project_id,
    union_id: user.union_id,
    project_key: projectKey,
    provider: authRow.provider,
    auth_id: authRow.id,
    resource_id: String(property.id || '').slice(0, 191),
    resource_label: String(property.label || '').slice(0, 255),
    resource_meta: JSON.stringify(meta),
    realtime_dashboard: 1,
    status: RecordStatus.ACTIVE,
    created_at: now,
    updated_at: now,
  }
}

export async function insertMount(db, user, projectKey, authRow, property, now) {
  await db.insert(project_data_source).values(mountRow(user, projectKey, authRow, property, now))
}

async function upsertProjectRows(db, rows) {
  for (let offset = 0; offset < rows.length; offset += 5) {
    await db.insert(project_list).values(rows.slice(offset, offset + 5)).onConflictDoUpdate({
      target: [project_list.project_id, project_list.project_key],
      set: {
        name: sql.raw('excluded.name'),
        site_url: sql.raw('excluded.site_url'),
        timezone: sql.raw('excluded.timezone'),
        status: RecordStatus.ACTIVE,
        updated_at: sql.raw('excluded.updated_at'),
      },
    })
  }
}

async function upsertMountRows(db, rows) {
  for (let offset = 0; offset < rows.length; offset += 5) {
    await db.insert(project_data_source).values(rows.slice(offset, offset + 5)).onConflictDoUpdate({
      target: [
        project_data_source.project_id,
        project_data_source.project_key,
        project_data_source.provider,
        project_data_source.resource_id,
      ],
      set: {
        auth_id: sql.raw('excluded.auth_id'),
        resource_label: sql.raw('excluded.resource_label'),
        resource_meta: sql.raw('excluded.resource_meta'),
        realtime_dashboard: sql.raw('excluded.realtime_dashboard'),
        status: RecordStatus.ACTIVE,
        updated_at: sql.raw('excluded.updated_at'),
      },
    })
  }
}

function uniqueProjectKey(usedKeys) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = generateProjectKey()
    if (!usedKeys.has(key)) {
      usedKeys.add(key)
      return key
    }
  }
  return ''
}

/**
 * 把 authRow 下所有 GA4 properties 同步成项目 (一对一).
 *
 * @param {object} args
 * @param {*} args.db        Drizzle 实例
 * @param {*} args.event     H3 event (用于读 siteConfig / cloudflare env)
 * @param {*} args.authRow   data_source_auth 行 (新写入或 update 后的最新版本)
 * @param {{project_id, union_id}} args.user 当前 session user
 * @param {boolean} args.overwriteExisting (default false)
 *        false → OAuth 回调路径: 已挂载 skip, 只 create 新的
 *        true  → 用户主动 sync 路径: 已挂载 update (name/url/meta 用远端覆盖)
 *
 * @returns {Promise<{
 *   complete: boolean,
 *   created: number,
 *   updated: number,
 *   removed: number,
 *   skipped: number,
 *   properties: Array,
 *   affected_project_keys: Array<string>
 * }>}
 */
export async function syncPropertiesAsProjects({ db, event, authRow, user, overwriteExisting = false }) {
  /* ---- 拉 properties: 失败绝不能伪装成空集合，否则会误删全部本地挂载 ---- */
  let properties = []
  try {
    properties = await fetchProperties(db, authRow, event)
  } catch (e) {
    console.error('[auto-sync] listProperties failed:', e?.message)
    return {
      error: publicSyncErrorCode(e),
      complete: false,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      properties: [],
      affected_project_keys: [],
    }
  }
  if (!Array.isArray(properties)) {
    console.error('[auto-sync] invalid properties response shape')
    return {
      complete: false,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      properties: [],
      affected_project_keys: [],
    }
  }

  const now = Math.floor(Date.now() / 1000)
  let created = 0
  let updated = 0
  let skipped = 0

  /* D1 免费套餐每次调用的查询数有限。先把现状各读一次，再在内存中对账，
     最后每 5 行批量 upsert；资源数量增长不再线性放大 SQL 次数。 */
  const [mountedRows, existingProjects] = await Promise.all([
    db.select().from(project_data_source).where(and(
      eq(project_data_source.project_id, user.project_id),
      eq(project_data_source.union_id, user.union_id),
      eq(project_data_source.provider, authRow.provider),
      eq(project_data_source.status, RecordStatus.ACTIVE),
    )),
    db.select({ project_key: project_list.project_key }).from(project_list).where(
      eq(project_list.project_id, user.project_id),
    ),
  ])
  const mountedByResource = new Map()
  for (const row of mountedRows) {
    if (!mountedByResource.has(row.resource_id)) mountedByResource.set(row.resource_id, row)
  }
  const localRowsForAuth = mountedRows.filter((row) => Number(row.auth_id) === Number(authRow.id))
  const usedProjectKeys = new Set(existingProjects.map((row) => row.project_key))
  const seenResources = new Set()
  const projectRows = []
  const mountRows = []

  for (const property of properties) {
    const resourceId = String(property?.id || '').trim()
    if (!resourceId || seenResources.has(resourceId)) {
      skipped++
      continue
    }
    seenResources.add(resourceId)

    const mounted = mountedByResource.get(resourceId)
    if (mounted) {
      if (!overwriteExisting) {
        skipped++
        continue
      }
      projectRows.push(projectRow(user, mounted.project_key, property, now))
      mountRows.push(mountRow(user, mounted.project_key, authRow, property, now))
      updated++
      continue
    }

    const projectKey = uniqueProjectKey(usedProjectKeys)
    if (!projectKey) {
      skipped++
      continue
    }
    projectRows.push(projectRow(user, projectKey, property, now))
    mountRows.push(mountRow(user, projectKey, authRow, property, now))
    mountedByResource.set(resourceId, { project_key: projectKey, resource_id: resourceId, auth_id: authRow.id })
    created++
  }

  await upsertProjectRows(db, projectRows)
  await upsertMountRows(db, mountRows)

  /* ---- 只有完整快照成功后才做差集清理；成功空数组也会正确清空旧挂载 ---- */
  const reconciliation = await reconcileRemovedResources(db, user, authRow, properties, now, localRowsForAuth)

  return {
    complete: true,
    created,
    updated,
    removed: reconciliation.removed,
    skipped,
    properties,
    affected_project_keys: reconciliation.affectedProjectKeys,
  }
}

/* ===================================================================
 *  GSC: 仅关联到现有项目, 不创建项目
 *  --
 *  GA4 是数据主入口 (一个 property = 一个站点身份, 没有项目就建项目);
 *  GSC 是补充数据源 (搜索流量分析), 站点身份必须先存在 — 找不到匹配
 *  项目就 skip, 防止 GSC 沉淀大量"空壳项目"破坏 UI.
 *
 *  匹配键 = domain (去 www / 去末尾 /):
 *    项目 site_url       https://example.com/foo  → example.com
 *    GSC url-prefix      https://example.com/     → example.com
 *    GSC sc-domain       sc-domain:example.com    → example.com
 *
 *  同一 domain 命中多个项目时取最早创建的 (id ASC), 保证幂等.
 * =================================================================== */

/* ---- domain 归一化: 失败统一返空串, 让 caller skip ---- */
function extractDomain(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  if (s.startsWith('sc-domain:')) {
    return s.slice('sc-domain:'.length).replace(/^www\./, '')
  }
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/* ---- 拉 sites: gsc provider 内部已返回对齐 GA4 的 { id, label, meta } ---- */
async function fetchSites(db, authRow, event) {
  const provider = providerOf(authRow.provider)
  const jwtSecret = getAppSecret(event)
  const credential = await getProviderCredential(db, authRow, jwtSecret, event.context.siteConfig)
  return provider.listProperties({ accessToken: credential, apiKey: credential })
}

/* ---- 写一行 GSC 挂载 (resource_id = siteUrl 原值, 与 GA4 同源约定) ---- */
function gscMountRow(user, projectKey, authRow, site, now) {
  const meta = {
    site_url:         site?.meta?.site_url || site?.id || '',
    kind:             site?.meta?.kind || '',
    permission_level: site?.meta?.permission_level || '',
  }
  return {
    project_id: user.project_id,
    union_id: user.union_id,
    project_key: projectKey,
    provider: authRow.provider,
    auth_id: authRow.id,
    resource_id: String(site.id || '').slice(0, 191),
    resource_label: String(site.label || '').slice(0, 255),
    resource_meta: JSON.stringify(meta),
    realtime_dashboard: 0,         /* GSC 无实时数据流 */
    status: RecordStatus.ACTIVE,
    created_at: now,
    updated_at: now,
  }
}

/* ---- GSC site → 反推项目用的 name / site_url
        url-prefix `https://example.com/` → name='example.com', site_url='https://example.com/'
        sc-domain  `sc-domain:example.com` → name='example.com', site_url='https://example.com/' ---- */
function gscSiteToProjectFields(site) {
  const raw = String(site?.meta?.site_url || site?.id || '').trim()
  if (raw.startsWith('sc-domain:')) {
    const dom = raw.slice('sc-domain:'.length).replace(/^www\./, '')
    return { name: dom, site_url: `https://${dom}/` }
  }
  /* url-prefix: 取 hostname 作 name, 原 URL 作 site_url */
  try {
    const u = new URL(raw)
    return {
      name: u.hostname.replace(/^www\./, ''),
      site_url: raw,
    }
  } catch {
    return { name: String(site?.label || raw).slice(0, 100), site_url: raw }
  }
}

/* ---- 写一行 project_list (GSC 自动创建路径) ---- */
function gscProjectRow(user, projectKey, site, now) {
  const fields = gscSiteToProjectFields(site)
  return {
    project_id: user.project_id,
    union_id: user.union_id,
    project_key: projectKey,
    name: String(fields.name || 'Search Console Site').slice(0, 100),
    description: '',
    site_url: String(fields.site_url || '').slice(0, 500),
    logo_url: '',
    timezone: '',
    priority: 0,
    status: RecordStatus.ACTIVE,
    created_at: now,
    updated_at: now,
  }
}

/**
 * 把 authRow 下所有 GSC / Bing sites 同步到项目.
 *
 *  - 优先按 domain 关联现有项目，找不到时创建项目
 *  - 不更新已挂: GSC site 没有"显示名/URL 变更"概念, skip 即幂等
 *  - 返回形态与 syncPropertiesAsProjects 一致, 便于上层统一处理
 *
 * @returns {Promise<{
 *   complete: boolean,
 *   created: number,
 *   updated: number,
 *   removed: number,
 *   skipped: number,
 *   properties: Array,
 *   affected_project_keys: Array<string>
 * }>}
 */
export async function syncSitesAsLinks({ db, event, authRow, user }) {
  let sites = []
  try {
    sites = await fetchSites(db, authRow, event)
  } catch (e) {
    console.error('[auto-sync gsc] listSites failed:', e?.message)
    return {
      error: publicSyncErrorCode(e),
      complete: false,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      properties: [],
      affected_project_keys: [],
    }
  }
  if (!Array.isArray(sites)) {
    console.error('[auto-sync gsc] invalid sites response shape')
    return {
      complete: false,
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      properties: [],
      affected_project_keys: [],
    }
  }

  /* 一次性建 domain → project 映射 (id ASC: 同 domain 多项目时确定性取最早建的,
     兑现"GSC 只关联其中一个 GA4 项目, 其余不管") */
  const projects = await db.select().from(project_list)
    .where(and(
      eq(project_list.project_id, user.project_id),
      eq(project_list.union_id,   user.union_id),
    ))
    .orderBy(asc(project_list.id))
  const projectsByDomain = new Map()
  for (const p of projects) {
    if (p.status !== RecordStatus.ACTIVE) continue
    const d = extractDomain(p.site_url)
    if (!d) continue
    if (!projectsByDomain.has(d)) projectsByDomain.set(d, p)
  }

  const now = Math.floor(Date.now() / 1000)
  let created = 0   /* 含 created (新项目) + linked (挂现有), 对上层 OAuth 回调 "synced N" 提示口径友好 */
  let skipped = 0
  const mountedRows = await db.select().from(project_data_source).where(and(
    eq(project_data_source.project_id, user.project_id),
    eq(project_data_source.union_id, user.union_id),
    eq(project_data_source.provider, authRow.provider),
    eq(project_data_source.status, RecordStatus.ACTIVE),
  ))
  const mountedResources = new Set(mountedRows.map((row) => String(row.resource_id || '')))
  const localRowsForAuth = mountedRows.filter((row) => Number(row.auth_id) === Number(authRow.id))
  const usedProjectKeys = new Set(projects.map((row) => row.project_key))
  const seenResources = new Set()
  const projectRows = []
  const mountRows = []

  for (const site of sites) {
    const resourceId = String(site?.id || '').trim()
    if (!resourceId || seenResources.has(resourceId) || mountedResources.has(resourceId)) {
      skipped++
      continue
    }
    seenResources.add(resourceId)

    const domain = extractDomain(site?.meta?.site_url || resourceId)
    let project = domain ? projectsByDomain.get(domain) : null
    if (!project) {
      const projectKey = uniqueProjectKey(usedProjectKeys)
      if (!projectKey) {
        skipped++
        continue
      }
      const row = gscProjectRow(user, projectKey, site, now)
      projectRows.push(row)
      project = row
      if (domain) projectsByDomain.set(domain, row)
    }

    mountRows.push(gscMountRow(user, project.project_key, authRow, site, now))
    mountedResources.add(resourceId)
    created++
  }

  await upsertProjectRows(db, projectRows)
  await upsertMountRows(db, mountRows)

  const reconciliation = await reconcileRemovedResources(db, user, authRow, sites, now, localRowsForAuth)

  return {
    complete: true,
    created,
    updated: 0,
    removed: reconciliation.removed,
    skipped,
    properties: sites,
    affected_project_keys: reconciliation.affectedProjectKeys,
  }
}

/* ===================================================================
 *  统一 dispatcher - callback / sync handler 共用入口
 *
 *  调用方不必关心 provider 差异:
 *    ga4 → syncPropertiesAsProjects (创建项目 + 挂载, 可 overwrite)
 *    gsc / bing → syncSitesAsLinks  (按 domain 关联或创建项目)
 *    当前只接受注册表中的 ga4 / gsc / bing
 * =================================================================== */
export async function syncResourcesFromAuth({ db, event, authRow, user, overwriteExisting = false }) {
  if (!authRow?.provider) throw createError({ statusCode: 400, message: 'provider required' })
  if (authRow.provider === 'ga4') {
    return syncPropertiesAsProjects({ db, event, authRow, user, overwriteExisting })
  }
  if (authRow.provider === 'gsc' || authRow.provider === 'bing') {
    return syncSitesAsLinks({ db, event, authRow, user })
  }
  throw createError({ statusCode: 400, message: `unknown provider: ${authRow.provider}` })
}
