/* ===================================================================
 * GA4 / Google OAuth helper - 纯函数, 不依赖 H3 上下文
 *
 * 围绕 Google 三件套 endpoints:
 *   AUTH    https://accounts.google.com/o/oauth2/v2/auth
 *   TOKEN   https://oauth2.googleapis.com/token
 *   REVOKE  https://oauth2.googleapis.com/revoke
 *   USER    https://www.googleapis.com/oauth2/v3/userinfo
 *
 * 调用方约定:
 *   - clientId / clientSecret 来自 Worker 环境，调用方显式注入
 *   - redirectUri 由 caller 拼好 (避免 helper 关心 host)
 *   - 出参字段名与 Google 官方一致 (access_token / refresh_token / expires_in / scope)
 * =================================================================== */

import { mapLimit } from '../map-limit'
import { googleApiErrorCode } from '../google-api-error'

const ENDPOINT_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const ENDPOINT_TOKEN = 'https://oauth2.googleapis.com/token'
const ENDPOINT_REVOKE = 'https://oauth2.googleapis.com/revoke'
const ENDPOINT_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo'

/* ----------------------------------------------------------------
 *  GA4 OAuth scope 集 — 渐进式权限设计
 *  --
 *  basic (默认首次授权):
 *    analytics.readonly + userinfo.{email,profile}
 *    用户第一眼只看到"读取分析数据"权限请求 — 心理门槛低, 不吓跑.
 *
 *  extended (创建网站时按需升级):
 *    basic + analytics.edit
 *    用户在 ProjectFormModal 提交"新建网站"时, 后端检测当前 scope
 *    不含 edit, 提示用户回 data-sources 走 mode=extended 重新授权.
 *  --
 *  Google OAuth `include_granted_scopes=true` 让 extended 授权时
 *  保留原有 readonly 权限, 不需要用户重新勾选每一项.
 * ---------------------------------------------------------------- */
const SCOPES_BASIC = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

const SCOPES_EXTENDED = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

/* ---- 给前端 / 后端做"是否已授 edit"判定的常量, 避免硬编码字符串 ---- */
export const SCOPE_GA4_EDIT = 'https://www.googleapis.com/auth/analytics.edit'
/* 旧版 full analytics scope (读写一体); 部分老用户授的是它而非 .edit, 同样可改 property */
export const SCOPE_GA4_FULL = 'https://www.googleapis.com/auth/analytics'

export function scopeForMode(mode = 'basic') {
  return mode === 'extended' ? SCOPES_EXTENDED : SCOPES_BASIC
}

export function hasRequiredScopes(grantedScope, mode = 'basic') {
  const granted = new Set(String(grantedScope || '').split(/\s+/).filter(Boolean))
  const canRead = granted.has('https://www.googleapis.com/auth/analytics.readonly')
    || granted.has(SCOPE_GA4_FULL)
  const canWrite = granted.has(SCOPE_GA4_EDIT) || granted.has(SCOPE_GA4_FULL)
  return canRead && (mode !== 'extended' || canWrite)
}

/* ---- 拼授权 URL ----
 *  mode 参数:
 *    'basic'    — 默认, 仅 readonly (首次授权友好)
 *    'extended' — 升级 scope 含 edit (创建 GA4 property 时需要)
 */
export function buildAuthUrl({ clientId, state, redirectUri, mode = 'basic' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeForMode(mode),
    access_type: 'offline',         /* 必须, 才能回 refresh_token */
    include_granted_scopes: 'true', /* 增量授权: extended 升级时保留原 basic */
    prompt: 'select_account consent', /* 多账号可选；显式同意保证下发 refresh_token */
    state,
  })
  return `${ENDPOINT_AUTH}?${params.toString()}`
}

/* ---- code -> token 交换 ---- */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetch(ENDPOINT_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw createError({ statusCode: 400, message: `oauth_exchange_failed:${res.status}`, data: txt.slice(0, 200) })
  }
  return res.json()
}

/* ---- refresh_token -> 新 access_token ---- */
export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  })
  const res = await fetch(ENDPOINT_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let errorCode = ''
    try {
      errorCode = JSON.parse(text)?.error || ''
    } catch {
      /* 非 JSON 错误页也属于上游故障，不能据此判定授权过期 */
    }
    if (res.status === 400 && errorCode === 'invalid_grant') return null

    const temporary = res.status === 429 || res.status >= 500
    throw createError({
      statusCode: temporary ? 503 : 502,
      message: temporary ? 'oauth_refresh_temporarily_unavailable' : 'oauth_refresh_failed',
      data: text.slice(0, 200),
    })
  }
  return res.json()
}

/* ---- revoke (删除时尽力一发, 失败不阻塞业务) ---- */
export async function revoke({ token }) {
  if (!token) return false
  try {
    const res = await fetch(`${ENDPOINT_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

/* ---- 用 access_token 拉账号画像 (sub / email / name / picture) ---- */
export async function fetchUserInfo({ accessToken }) {
  const res = await fetch(ENDPOINT_USERINFO, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw createError({ statusCode: res.status, message: 'userinfo_failed' })
  }
  return res.json()
}

/* ===================================================================
 *  GA4 Admin API - 账号 / 属性 / 数据流 列举
 *
 *  401 -> 抛 token_invalid, 让上层降级 status=99
 *  403 -> 抛 ga4_permission_denied, token 仍可能有效
 *  其它 -> 抛 ga4_admin_error
 * =================================================================== */

const ENDPOINT_ADMIN = 'https://analyticsadmin.googleapis.com/v1beta'

function throwAdminError(status, text = '') {
  if (status === 401) {
    throw createError({ statusCode: 401, message: 'token_invalid', data: text.slice(0, 200) })
  }
  if (status === 403) {
    throw createError({ statusCode: 403, message: googleApiErrorCode(text, 'ga4_permission_denied') })
  }
  throw createError({ statusCode: status, message: 'ga4_admin_error', data: text.slice(0, 200) })
}

async function adminGet({ accessToken, path }) {
  const res = await fetch(`${ENDPOINT_ADMIN}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throwAdminError(res.status, txt)
  }
  return res.json()
}

/* ===================================================================
 *  adminGetAll - 翻页拉全: 跟随 nextPageToken 合并所有页
 *  --
 *  GA4 Admin API (accounts / properties) 默认 pageSize=50, 最大 200, 且分页
 *  返回 nextPageToken. 不翻页会静默漏掉超出首页的资源 (账号/属性多于 50 时).
 *  统一用 pageSize=200 + 循环跟 token 把全部资源拉下来.
 *  --
 *  @param path     不含分页参数的基础路径 (可自带 ?filter=...)
 *  @param itemsKey 响应里的数组字段名 ('accounts' | 'properties')
 *  maxPages=50 安全阀: 防异常 token 死循环 (50×200=1 万, 远超真实用量)
 *  错误语义与 adminGet 一致 (token_invalid / ga4_permission_denied / ga4_admin_error 直接抛给调用方)
 * =================================================================== */
async function adminGetAll({ accessToken, path, itemsKey }) {
  const sep = path.includes('?') ? '&' : '?'
  const all = []
  let pageToken = ''
  for (let page = 0; page < 50; page++) {
    const tokenQuery = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    const resp = await adminGet({ accessToken, path: `${path}${sep}pageSize=200${tokenQuery}` })
    const validObject = resp && typeof resp === 'object' && !Array.isArray(resp)
    const responseKeys = validObject ? Object.keys(resp) : []
    const validKeys = responseKeys.every((key) => key === itemsKey || key === 'nextPageToken')
    const validItems = !Object.prototype.hasOwnProperty.call(resp || {}, itemsKey)
      || Array.isArray(resp[itemsKey])
    const validToken = !Object.prototype.hasOwnProperty.call(resp || {}, 'nextPageToken')
      || typeof resp.nextPageToken === 'string'
    if (!validObject || !validKeys || !validItems || !validToken) {
      throw createError({ statusCode: 502, message: 'ga4_admin_response_invalid' })
    }
    const items = Array.isArray(resp?.[itemsKey]) ? resp[itemsKey] : []
    all.push(...items)
    pageToken = resp?.nextPageToken || ''
    if (!pageToken) break
  }
  if (pageToken) {
    throw createError({ statusCode: 502, message: 'ga4_admin_pagination_incomplete' })
  }
  return all
}

/* ---- 通用 POST: 与 adminGet 错误语义对齐 ----
 *  401 -> token_invalid (上层 markReauth + 提示用户重连)
 *  403 -> ga4_permission_denied (权限/账号问题, 不是 token 问题)
 *  其它 4xx/5xx -> ga4_admin_error (statusCode 透传 GA4)
 *  --- */
async function adminPost({ accessToken, path, body }) {
  const res = await fetch(`${ENDPOINT_ADMIN}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throwAdminError(res.status, txt)
  }
  return res.json()
}

/* ---- 通用 PATCH: GA4 Admin API 用 ?updateMask=field1,field2 指明改哪些字段
 *  401/403 由 throwAdminError 区分 token 与权限
 *  --- */
async function adminPatch({ accessToken, path, body }) {
  const res = await fetch(`${ENDPOINT_ADMIN}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throwAdminError(res.status, txt)
  }
  return res.json()
}

/* ===================================================================
 *  listAdminAccounts - 列当前 OAuth token 可见的全部 GA accounts
 *
 *  返回原样 [{ name: 'accounts/123', displayName, ... }, ...]
 *  调用方:
 *    - listProperties 内部 (拉每个账号下的 property)
 *    - create-with-ga4 (创建新 property 时挑 parent account)
 * =================================================================== */
export async function listAdminAccounts({ accessToken }) {
  return adminGetAll({ accessToken, path: '/accounts', itemsKey: 'accounts' })
}

/* ===================================================================
 *  createProperty - 在指定 GA account 下创建一个新的 GA4 property
 *
 *  入参:
 *    accountName   - 'accounts/12345'
 *    displayName   - 用户输入的网站名 (即 project.name)
 *    timeZone      - IANA tz, 默认 'UTC'
 *    currencyCode  - ISO 4217, 默认 'USD'
 *    industryCategory - 行业分类, 默认 'TECHNOLOGY' (Google 容忍但建议传)
 *
 *  返回 GA4 property 对象 { name: 'properties/xxx', ... }
 *
 *  失败:
 *    401 -> token_invalid
 *    403 -> ga4_permission_denied (scope 不够 / account 不可写)
 *    其它 -> ga4_admin_error
 * =================================================================== */
export async function createProperty({
  accessToken,
  accountName,
  displayName,
  timeZone = 'UTC',
  currencyCode = 'USD',
  industryCategory = 'TECHNOLOGY',
}) {
  return adminPost({
    accessToken,
    path: '/properties',
    body: {
      parent: accountName,
      displayName: String(displayName || '').slice(0, 100),
      timeZone,
      currencyCode,
      industryCategory,
    },
  })
}

/* ===================================================================
 *  createWebDataStream - 给 property 挂一个 web data stream
 *
 *  入参:
 *    propertyName  - 'properties/xxx' (即 createProperty 返回的 name)
 *    displayName   - stream 的显示名 (与 property displayName 一致最直观)
 *    defaultUri    - 用户站点 URL (含 protocol)
 *
 *  返回 dataStream 对象, 其中 webStreamData.measurementId 是 GA4 衡量 ID,
 *  前端拿到后引导用户把 GA4 跟踪代码贴到自己的网站上.
 * =================================================================== */
export async function createWebDataStream({ accessToken, propertyName, displayName, defaultUri }) {
  return adminPost({
    accessToken,
    path: `/${propertyName}/dataStreams`,
    body: {
      type: 'WEB_DATA_STREAM',
      displayName: String(displayName || '').slice(0, 255),
      webStreamData: { defaultUri: String(defaultUri || '') },
    },
  })
}

/* ===================================================================
 *  GA4 Demo Property 黑名单
 *
 *  Google 给所有用户挂的"演示账号"会出现在 listProperties 结果里, 但
 *  Data API 查询会 403 (用户对 demo property 只有 Admin API 读权限,
 *  没有 Data API 读权限). 直接在 provider 层把它们摘掉:
 *    - 单点过滤, auto-sync 与前端"手动挂载选 resource"两条路径同时受益
 *    - 双保险: 按官方 property_id 黑名单 + 按名字前缀模糊
 *  --
 *  已知 Google demo property:
 *    properties/153293282  GA4 - Flood-It!
 *    properties/213025502  GA4 - Google Merch Shop
 *    properties/386205232  Google Analytics Sample - GA4 Web (旧 demo)
 * =================================================================== */
const DEMO_PROPERTY_IDS = new Set([
  'properties/153293282',
  'properties/213025502',
  'properties/386205232',
])
const DEMO_NAME_PATTERN = /^(GA4 - )?(Flood-It|Google Merch Shop|Google Analytics Sample)/i

function isDemoProperty(p) {
  if (DEMO_PROPERTY_IDS.has(String(p?.name || ''))) return true
  return DEMO_NAME_PATTERN.test(String(p?.displayName || ''))
}

/**
 * 列当前授权下所有可访问的 GA4 properties (合并 account 元信息)
 * 返回统一的 resources[] 结构
 *
 * Demo 账号 (Flood-It! / Google Merch Shop) 已被过滤 — 它们对 Data API 无读权限,
 * 同步过去除了占位没意义.
 */
export async function listProperties({ accessToken }) {
  const accounts = await listAdminAccounts({ accessToken })
  if (accounts.length === 0) return []

  /* Cloudflare 每次请求最多 6 条并行出站连接。先列举全部 property，
     再共用一个并发池读取 data stream，避免嵌套 Promise.all 放大并发。 */
  const accountProperties = await mapLimit(accounts, 6, async (acc) => {
    const id = String(acc.name || '').replace(/^accounts\//, '')
    if (!id) throw createError({ statusCode: 502, message: 'ga4_admin_account_identity_missing' })

    /* 任一账号 properties 分页失败就让整个快照失败。
       不能把局部失败吞成 [], 否则集合对账会误删该账号的全部本地站点。 */
    const props = await adminGetAll({
      accessToken,
      path: `/properties?filter=${encodeURIComponent('parent:accounts/' + id)}`,
      itemsKey: 'properties',
    })
    if (props.some((p) => !String(p?.name || '').trim())) {
      throw createError({ statusCode: 502, message: 'ga4_admin_property_identity_missing' })
    }
    return props
      .filter((p) => !isDemoProperty(p))
      .map((property) => ({ acc, property }))
  })

  const entries = accountProperties.flat()
  return mapLimit(entries, 6, async ({ acc, property: p }) => {
      const stream = await fetchWebStreamInfo(accessToken, p.name)
      return {
        id: p.name,
        label: p.displayName || p.name,
        meta: {
          account_id: acc.name,
          account_name: acc.displayName || '',
          property_id: p.name,
          create_time: p.createTime || '',
          timezone: p.timeZone || '',
          currency: p.currencyCode || '',
          website_uri:    stream.defaultUri,
          measurement_id: stream.measurementId,
        },
      }
  })
}

/* ===================================================================
 *  拉某 property 的 web data stream 关键信息
 *  --
 *  返回:    { name, defaultUri, measurementId }
 *           失败时返 { name:'', defaultUri:'', measurementId:'' }
 *  name 字段是 stream 的完整 path (eg "properties/123/dataStreams/456"),
 *  patch 时直接拼到 URL 用. measurementId 给安装代码弹窗用.
 *  注意: 一个 property 可能挂多个 stream, 我们只取第一个 WEB_DATA_STREAM
 *  暴露 export: install-code 接口的 lazy backfill 复用此函数, 不必再封一层
 * =================================================================== */
export async function fetchWebStreamInfo(accessToken, propertyName) {
  try {
    const resp = await adminGet({ accessToken, path: `/${propertyName}/dataStreams` })
    const streams = Array.isArray(resp?.dataStreams) ? resp.dataStreams : []
    const web = streams.find((s) => s.type === 'WEB_DATA_STREAM')
    return {
      name:          web?.name                          || '',
      defaultUri:    web?.webStreamData?.defaultUri    || '',
      measurementId: web?.webStreamData?.measurementId || '',
    }
  } catch {
    return { name: '', defaultUri: '', measurementId: '' }
  }
}

/* ===================================================================
 *  patchPropertyDisplayName - 改 GA4 property 名 (站点改名同步)
 *  --
 *  propertyName: 完整路径 "properties/123" (跟 listProperties.id 同源)
 *  需 access_token 含 analytics.edit scope, 否则 403 → ga4_permission_denied
 * =================================================================== */
export async function patchPropertyDisplayName({ accessToken, propertyName, displayName }) {
  return adminPatch({
    accessToken,
    path: `/${propertyName}?updateMask=displayName`,
    body: { displayName: String(displayName || '').slice(0, 255) },
  })
}

/* ===================================================================
 *  patchWebStreamDefaultUri - 改 GA4 web stream 的 defaultUri (站点 URL 同步)
 *  --
 *  streamName: 完整路径 "properties/123/dataStreams/456"
 *  caller 用 fetchWebStreamInfo 先拿到 streamName 再调本函数
 * =================================================================== */
export async function patchWebStreamDefaultUri({ accessToken, streamName, defaultUri }) {
  return adminPatch({
    accessToken,
    path: `/${streamName}?updateMask=webStreamData.defaultUri`,
    body: { webStreamData: { defaultUri: String(defaultUri || '') } },
  })
}

/* ---- 通用 DELETE: 与 adminGet 错误语义对齐
 *  GA4 DELETE 成功返回空 body, json() 兜底空对象避免解析报错 --- */
async function adminDelete({ accessToken, path }) {
  const res = await fetch(`${ENDPOINT_ADMIN}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throwAdminError(res.status, txt)
  }
  return res.json().catch(() => ({}))
}

/* ===================================================================
 *  deleteProperty - 软删一个 GA4 property (移入 Google 回收站)
 *  --
 *  GA4 Admin API DELETE /properties/{id} 是软删: property 进 Google 回收站,
 *  72 小时后永久删除, 期间用户可在 GA4 后台自行恢复 — 对误删友好.
 *  propertyName: 完整路径 "properties/123" (跟 listProperties.id / resource_id 同源)
 *  需 access_token 含 analytics.edit scope, 否则 403 → ga4_permission_denied
 * =================================================================== */
export async function deleteProperty({ accessToken, propertyName }) {
  const name = String(propertyName || '').trim()
  if (!name) throw createError({ statusCode: 400, message: 'property_name_required' })
  const path = name.startsWith('properties/') ? `/${name}` : `/properties/${name}`
  return adminDelete({ accessToken, path })
}
