/* ===================================================================
 * GSC (Google Search Console) provider - OAuth + Sites 列举
 *
 *  与 ga4-oauth.js 完全对称的 Google OAuth 三件套, 共享同一组 Google
 *  token/userinfo/revoke endpoints, 仅 scope 与资源 API 不同.
 *
 *  Scope 渐进式权限设计 (与 GA4 同款语义, 不同字符串):
 *    basic    = webmasters.readonly + userinfo.{email,profile}
 *               只读: 拉 sites / 查询 search analytics 数据
 *    extended = webmasters             + userinfo.{email,profile}
 *               读写: 增删 sites / 提交 sitemap / URL 检查等
 *               (webmasters 含 readonly 一切权限, 不需要叠加 readonly)
 *
 *  资源形态对齐 GA4: { id, label, meta }, 让上游 resources.get.js /
 *  auto-sync dispatcher 不需要 if/else 走 provider 分支.
 *
 *  GSC sites 两种 siteUrl 形态:
 *    URL prefix property:  https://example.com/   (含协议 + 末尾 /)
 *    Domain property:      sc-domain:example.com  (协议无关, 子域全包)
 *  两者 listSites 都会返回, 我们原样回传 (上游 extractDomain 工具统一处理).
 * =================================================================== */

import { isCustomPeriod, parseCustomPeriod } from '../period'
import { googleApiErrorCode } from '../google-api-error'

const ENDPOINT_AUTH     = 'https://accounts.google.com/o/oauth2/v2/auth'
const ENDPOINT_TOKEN    = 'https://oauth2.googleapis.com/token'
const ENDPOINT_REVOKE   = 'https://oauth2.googleapis.com/revoke'
const ENDPOINT_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo'
const ENDPOINT_GSC      = 'https://searchconsole.googleapis.com/webmasters/v3'

/* ---- Scope 集 ---- */
const SCOPES_BASIC = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

const SCOPES_EXTENDED = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

/* ---- 给前端"是否已授读写权限"判定的常量 (与 GA4 SCOPE_GA4_EDIT 同款) ---- */
export const SCOPE_GSC_WRITE = 'https://www.googleapis.com/auth/webmasters'

export function scopeForMode(mode = 'basic') {
  return mode === 'extended' ? SCOPES_EXTENDED : SCOPES_BASIC
}

export function hasRequiredScopes(grantedScope, mode = 'basic') {
  const granted = new Set(String(grantedScope || '').split(/\s+/).filter(Boolean))
  const canWrite = granted.has(SCOPE_GSC_WRITE)
  const canRead = canWrite || granted.has('https://www.googleapis.com/auth/webmasters.readonly')
  return canRead && (mode !== 'extended' || canWrite)
}

/* ===================================================================
 *  OAuth 三件套: 与 GA4 同款实现, 只是 scope 不同
 *  --
 *  buildAuthUrl mode 语义:
 *    'basic'    (默认) → readonly
 *    'extended'        → read+write
 * =================================================================== */

export function buildAuthUrl({ clientId, state, redirectUri, mode = 'basic' }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeForMode(mode),
    access_type: 'offline',          /* 必须, 才能回 refresh_token */
    include_granted_scopes: 'true',  /* 增量授权: 升级时保留原 scopes */
    prompt: 'select_account consent', /* 多账号可选；显式同意保证下发 refresh_token */
    state,
  })
  return `${ENDPOINT_AUTH}?${params.toString()}`
}

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

export async function revoke({ token }) {
  if (!token) return false
  try {
    const res = await fetch(`${ENDPOINT_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

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
 *  Search Console Sites API
 *
 *  GET /webmasters/v3/sites
 *  返回 { siteEntry: [{ siteUrl, permissionLevel }] }
 *
 *  permissionLevel: siteOwner | siteFullUser | siteRestrictedUser | siteUnverifiedUser
 *  我们过滤掉 siteUnverifiedUser (无 search analytics 权限, 挂载无意义).
 * =================================================================== */

async function gscGet({ accessToken, path }) {
  const res = await fetch(`${ENDPOINT_GSC}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    if (res.status === 401) {
      throw createError({ statusCode: 401, message: 'token_invalid' })
    }
    if (res.status === 403) {
      const text = await res.text().catch(() => '')
      throw createError({ statusCode: 403, message: googleApiErrorCode(text, 'gsc_permission_denied') })
    }
    throw createError({ statusCode: res.status, message: 'gsc_api_error' })
  }
  return res.json()
}

/* ===================================================================
 *  listProperties - 返回形态对齐 GA4 listProperties:
 *    [{ id, label, meta: { ... } }, ...]
 *
 *  id            = siteUrl 原值 (作 resource_id, 写库主键)
 *  label         = 人类可读的"站点显示名" (去掉 sc-domain: 前缀 / 末尾 /)
 *  meta.site_url = siteUrl 原值
 *  meta.kind     = 'url-prefix' | 'sc-domain'
 *  meta.permission_level = GSC 原始权限值, 留作展示
 * =================================================================== */

export async function listProperties({ accessToken }) {
  const resp = await gscGet({ accessToken, path: '/sites' })
  const validObject = resp && typeof resp === 'object' && !Array.isArray(resp)
  const validKeys = validObject && Object.keys(resp).every((key) => key === 'siteEntry')
  const validEntries = !Object.prototype.hasOwnProperty.call(resp || {}, 'siteEntry')
    || Array.isArray(resp.siteEntry)
  if (!validObject || !validKeys || !validEntries) {
    throw createError({ statusCode: 502, message: 'gsc_sites_response_invalid' })
  }
  const entries = Array.isArray(resp?.siteEntry) ? resp.siteEntry : []
  if (entries.some((entry) => !String(entry?.siteUrl || '').trim())) {
    throw createError({ statusCode: 502, message: 'gsc_site_identity_missing' })
  }
  return entries
    .filter((e) => e?.siteUrl && e.permissionLevel !== 'siteUnverifiedUser')
    .map((e) => {
      const siteUrl = String(e.siteUrl)
      const kind = siteUrl.startsWith('sc-domain:') ? 'sc-domain' : 'url-prefix'
      const label = kind === 'sc-domain'
        ? siteUrl.slice('sc-domain:'.length)
        : siteUrl.replace(/\/$/, '')
      return {
        id: siteUrl,
        label,
        meta: {
          site_url: siteUrl,
          kind,
          permission_level: e.permissionLevel || '',
        },
      }
    })
}

/* ===================================================================
 *  GSC Search Analytics Query API
 *
 *  POST /sites/{siteUrl}/searchAnalytics/query
 *  Body: { startDate, endDate, dimensions: [...], rowLimit, ... }
 *
 *  GSC 数据延迟 ~2 天 (官方 fresh-data 接口仍非实时), 实时性远逊于 GA4 —
 *  缓存 TTL 拉长到与 GA4 60s 一致即可, 不必特别处理.
 *
 *  4 个核心 metric 永远全返 (impressions/clicks/ctr/position),
 *  body 里不需要也不能指定 metrics — GSC API 一律全返.
 *  --
 *  siteUrl 必须经 encodeURIComponent (url-prefix 形态含 / 需 escape;
 *  sc-domain 形态含 : 也需 escape).
 * =================================================================== */

async function gscPost({ accessToken, path, body }) {
  const res = await fetch(`${ENDPOINT_GSC}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 401) {
      throw createError({ statusCode: 401, message: 'token_invalid', data: txt.slice(0, 200) })
    }
    if (res.status === 403) {
      throw createError({ statusCode: 403, message: 'gsc_permission_denied', data: txt.slice(0, 200) })
    }
    /* 429 = quota exceeded, 让上层降级跳过单 site, 与 GA4 ratelimited 同语义 */
    if (res.status === 429) {
      throw createError({ statusCode: 503, message: 'gsc_rate_limited', data: txt.slice(0, 200) })
    }
    throw createError({ statusCode: res.status, message: 'gsc_api_error', data: txt.slice(0, 200) })
  }
  return res.json()
}

/* ---- GSC dimension 白名单 (前端 BarList tabs 与之对齐) ---- */
export const GSC_DIMENSIONS = new Set(['query', 'page', 'country', 'device', 'searchAppearance', 'date'])

/* ---- filter → GSC API dimensionFilterGroups
 *      GSC 支持 4 个维度筛选: query / page / country / device
 *      上层 (mapGa4FiltersToGsc) 已把 GA4 维度名/值转成 GSC 形态,
 *      这里只识别 GSC 原生维度名, 其他 skip.
 *      match 映射: exact→equals / not_equals→notEquals /
 *                 contains→contains / not_contains→notContains
 *      starts_with / ends_with 等 GA4 独有的 match GSC 没有, 降级为 contains ---- */
const GSC_FILTER_DIMS = new Set(['query', 'page', 'country', 'device'])

function buildDimensionFilters(filters) {
  if (!Array.isArray(filters) || !filters.length) return undefined
  const items = filters
    .filter((f) => f && GSC_FILTER_DIMS.has(f.dim) && f.value)
    .map((f) => ({
      dimension: f.dim,
      operator: f.match === 'exact' ? 'equals'
              : f.match === 'not_equals' ? 'notEquals'
              : f.match === 'not_contains' ? 'notContains'
              : 'contains',  /* contains / starts_with / ends_with / 其他 → 都用 contains */
      expression: String(f.value),
    }))
  if (!items.length) return undefined
  return [{ groupType: 'and', filters: items }]
}

/**
 * 跑一次 Search Analytics 查询.
 *
 *  入参:
 *    accessToken
 *    siteUrl         授权时拿到的 site identifier (url-prefix 或 sc-domain)
 *    startDate       YYYY-MM-DD
 *    endDate         YYYY-MM-DD
 *    dimensions      ['query'] / ['page'] / ['date'] / [] (返聚合 totals)
 *    rowLimit        默认 50, 最大 25000
 *    filters         [{ dim, match, value }, ...] — 仅 dim='query' 生效
 *
 *  返回原样 { rows: [{ keys, clicks, impressions, ctr, position }], ... }
 *  无数据 → { rows: [] }
 */
export async function runReport({
  accessToken,
  siteUrl,
  startDate,
  endDate,
  dimensions = [],
  rowLimit = 50,
  filters,
}) {
  if (!siteUrl) throw createError({ statusCode: 400, message: 'gsc_site_url_required' })
  const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`
  const body = {
    startDate: String(startDate),
    endDate: String(endDate),
    dimensions: Array.isArray(dimensions) ? dimensions.filter((d) => GSC_DIMENSIONS.has(d)) : [],
    rowLimit: Math.min(Math.max(Number(rowLimit) || 50, 1), 25000),
    dataState: 'final',  /* 排除未确定数据, 与 GA4 默认行为对齐 */
  }
  const dimFilters = buildDimensionFilters(filters)
  if (dimFilters) body.dimensionFilterGroups = dimFilters
  return gscPost({ accessToken, path, body })
}

/* ===================================================================
 *  辅助: GSC period 字符串 → { startDate, endDate }
 *
 *  与 GA4 periodToRange 对齐 (今日/昨日/7days/28days/90days/...),
 *  但 GSC 数据延迟 2-3 天, 'today' 通常无数据, 用户自行理解;
 *  endDate 一律传 today, GSC 自动忽略无数据日期.
 * =================================================================== */
export function periodToRange(period) {
  if (isCustomPeriod(period)) {
    const custom = parseCustomPeriod(period)
    if (custom) return custom   /* custom 已是绝对 ISO, 直接喂 GSC */
  }
  const now = new Date()
  const toIso = (d) => d.toISOString().slice(0, 10)
  const today = toIso(now)
  const shift = (days) => {
    const d = new Date(now); d.setDate(d.getDate() - days); return toIso(d)
  }
  switch (String(period)) {
    case 'today':     return { startDate: today, endDate: today }
    case 'yesterday': return { startDate: shift(1), endDate: shift(1) }
    case '7days':     return { startDate: shift(6),   endDate: today }
    case '28days':    return { startDate: shift(27),  endDate: today }
    case '90days':    return { startDate: shift(89),  endDate: today }
    case '6months':   return { startDate: shift(179), endDate: today }
    case '1year':     return { startDate: shift(364), endDate: today }
    default:          return { startDate: shift(6),   endDate: today }
  }
}

/* ===================================================================
 *  从 runReport 响应里抽 totals (无 dimensions 时单行即 totals;
 *  有 dimensions 时手动加总) — 与 GA4 extractTotals 对齐语义
 *
 *  返回 { impressions, clicks, ctr, position }
 *    ctr      = clicks / impressions (avg)
 *    position = impressions 加权 (与 GSC API 内部口径一致)
 * =================================================================== */
export function extractTotals(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : []
  if (!rows.length) return { impressions: 0, clicks: 0, ctr: 0, position: 0 }
  let impressions = 0, clicks = 0, posWeighted = 0
  for (const r of rows) {
    const imp = Number(r.impressions) || 0
    impressions += imp
    clicks      += Number(r.clicks) || 0
    posWeighted += (Number(r.position) || 0) * imp
  }
  return {
    impressions,
    clicks,
    ctr:      impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? posWeighted / impressions : 0,
  }
}

/* ===================================================================
 *  多 site 聚合: 同一 project 挂多个 GSC site 时, 跨 site totals 加总
 *  --
 *  ctr/position 用 impressions 加权, 与 extractTotals 同算法
 * =================================================================== */
export function aggregateMetrics(totalsList) {
  if (!Array.isArray(totalsList) || !totalsList.length) {
    return { impressions: 0, clicks: 0, ctr: 0, position: 0 }
  }
  let impressions = 0, clicks = 0, posWeighted = 0
  for (const t of totalsList) {
    const imp = Number(t?.impressions) || 0
    impressions += imp
    clicks      += Number(t?.clicks) || 0
    posWeighted += (Number(t?.position) || 0) * imp
  }
  return {
    impressions,
    clicks,
    ctr:      impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? posWeighted / impressions : 0,
  }
}
