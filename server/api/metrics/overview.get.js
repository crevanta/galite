/* ===================================================================
 * GET /api/metrics/overview?period=7days  (全站点摘要)
 *
 * 当前用户全部项目, 按 project 聚合简化指标 (4 字段) + 跨项目 totals.
 * 用于 projects.index 卡片视图: 一次请求拿全部, 不再 N 次 summary.
 *
 * 响应:
 *   {
 *     period: '7days',
 *     projects: [{ project_key, name, logo_url, site_url, metrics: {...4 字段} }],
 *     totals:   { ...4 字段 },         // 所有 project 跨站累加, 用于第一张总览卡
 *   }
 *
 * 缓存 key = ga4:user:{union_id}:{period}:overview
 * TTL    = 5 minutes; stale snapshots refresh in the background
 *
 * 失败容忍:
 *   - 单个 ds 任何错误 (503/401/其它) 都只 log + 跳过, 不让整个 overview 失败
 *   - GA4 配额场景下: 即使一个 property 限流, 其它项目正常返回数据
 *   - 401 同步标 auth.status=99 让前端弹"重新授权"
 * =================================================================== */

import { and, eq, inArray } from 'drizzle-orm'
import { project_list, project_data_source, data_source_auth } from '../../database/schema'
import { DataSourceProvider, MetricsPeriod, RecordStatus } from '../../utils/constants'
import { isValidPeriod } from '../../utils/period'
import { selectInBatches, useDb } from '../../utils/db'
import { getAccessToken } from '../../utils/data-source-token'
import { runReport, periodToRange, extractTotals, extractRows, aggregateMetrics } from '../../utils/providers/ga4'
import { buildCacheKey } from '../../utils/metrics-cache'
import { loadOverviewCache } from '../../utils/overview-cache'
import { getJwtSecret, getSiteConfig, markAuthInvalid } from '../../utils/metrics-helpers'
import { mapLimit } from '../../utils/map-limit'
import { addTimelinePoint, collectTimelineLabels, mergeTimeline, timelineValues } from '../../utils/sparkline'

const OVERVIEW_METRICS = [
  'screenPageViews',
  'totalUsers',
  'activeUsers',
  'averageSessionDuration',
  'sessions', /* 仅用于 averageSessionDuration 加权; 不出参 */
]
const OUTPUT_FIELDS = ['screenPageViews', 'totalUsers', 'activeUsers', 'averageSessionDuration']
const GA4_OVERVIEW_CONCURRENCY = 6

/* ===================================================================
 *  Sparkline 配置 - 按 period 决定 GA4 dimension + 聚合粒度
 *
 *  设计意图: 卡片小图永远 ~12-28 个点, 既能传递趋势又不撑爆响应体积
 *    today / yesterday → dateHour       (24 点)
 *    7days             → date            (7 点)
 *    28days            → date            (28 点)
 *    90days            → date + 按 7 天桶 (13 点)
 *    6months           → date + 按 7 天桶 (~26 点)
 *    1year             → yearMonth       (12 点)
 *
 *  bucketDays > 0 时, extractSparkline 会按桶累加, 让"按周/按月"的语义实现
 *  保留在后端 — 前端只拿到一个一维数组渲染.
 * =================================================================== */
const SPARKLINE_SPEC = {
  today:     { ga4Dim: 'dateHour',  bucketDays: 0 },
  yesterday: { ga4Dim: 'dateHour',  bucketDays: 0 },
  '7days':   { ga4Dim: 'date',      bucketDays: 0 },
  '28days':  { ga4Dim: 'date',      bucketDays: 0 },
  '90days':  { ga4Dim: 'date',      bucketDays: 7 },
  '6months': { ga4Dim: 'date',      bucketDays: 7 },
  '1year':   { ga4Dim: 'yearMonth', bucketDays: 0 },
}
function sparklineSpec(period) {
  return SPARKLINE_SPEC[period] || SPARKLINE_SPEC['7days']
}

/* ---- 从 GA4 report 抽带时间身份的 points
        指标永远用 screenPageViews (PV 是最普世的趋势信号).
        此处不提前转数组: 上游会省略 0 值日期，必须保留 key 到全局对齐完成. ---- */
function extractSparkline(report) {
  const rows = extractRows(report, ['screenPageViews'])
  const timeline = new Map()
  for (const row of rows) {
    addTimelinePoint(timeline, Object.values(row.dimensions || {})[0], {
      screenPageViews: row.metrics?.screenPageViews,
    })
  }
  return timeline
}

export default defineEventHandler(async (event) => {
  const user = requireAuth(event)
  const query = getQuery(event)
  const period = String(query.period || MetricsPeriod.LAST_7_DAYS)
  if (!isValidPeriod(period)) return reqFail('invalid_period')

  const startedAt = Date.now()
  const db = await useDb(event)
  const jwtSecret = getJwtSecret(event)
  const siteConfig = getSiteConfig(event)

  const cacheKey = buildCacheKey(['ga4', 'user', user.union_id, 'all', period, 'overview'])
  const build = async () => {

    /* ---- 先拉所有挂 GA4 的数据源 (按 project_data_source.provider=ga4 反查)
            再用 projectKeys IN 查 project_list, 只返"挂了 GA4 的项目"
            形态对称 overview/gsc.get.js, 避免 GSC-only 项目出现空白 GA4 卡 ---- */
    const range = periodToRange(period)
    const allDsRows = await db.select().from(project_data_source)
      .where(and(
        eq(project_data_source.project_id, user.project_id),
        eq(project_data_source.union_id, user.union_id),
        eq(project_data_source.provider, DataSourceProvider.GA4),
        eq(project_data_source.status, RecordStatus.ACTIVE),
      ))
    const dsRows = allDsRows

    if (!dsRows.length) {
      const empty = { period, projects: [], totals: pickOutput({}), sparkline: [] }
      return empty
    }

    /* ---- 项目元信息: 仅查 dsRows 涉及的 projectKeys ---- */
    const projectKeys = Array.from(new Set(dsRows.map((d) => d.project_key)))
    const projects = await selectInBatches(projectKeys, (keys) => db.select().from(project_list)
      .where(and(
        eq(project_list.project_id, user.project_id),
        eq(project_list.union_id, user.union_id),
        inArray(project_list.project_key, keys),
        eq(project_list.status, RecordStatus.ACTIVE),
      )))
    const projectByKey = new Map(projects.map((p) => [p.project_key, p]))
    const orderedProjects = projectKeys.map((pk) => projectByKey.get(pk)).filter(Boolean)

    if (!orderedProjects.length) {
      const empty = { period, projects: [], totals: pickOutput({}), sparkline: [] }
      return empty
    }

    /* ---- 授权与 token 去重: 多个 property 共用一个 Google auth 时只查库/解密/刷新一次 ---- */
    const authIds = Array.from(new Set(dsRows.map((d) => d.auth_id).filter(Boolean)))
    const authRows = authIds.length
      ? await selectInBatches(authIds, (ids) => db.select().from(data_source_auth)
        .where(and(
          eq(data_source_auth.project_id, user.project_id),
          eq(data_source_auth.union_id, user.union_id),
          inArray(data_source_auth.id, ids),
          eq(data_source_auth.status, RecordStatus.ACTIVE),
        )))
      : []
    const authById = new Map(authRows.map((a) => [a.id, a]))
    const tokenByAuthId = new Map()

    await mapLimit(authRows, GA4_OVERVIEW_CONCURRENCY, async (auth) => {
      tokenByAuthId.set(auth.id, await resolveAccessToken(db, auth, jwtSecret, siteConfig))
    })

    /* ---- 全 ds 并发跑 GA4 (单失败不阻塞其他)
            每个返回 { totals, sparkline }; 同项目多 ds 时聚合阶段一并合并 ---- */
    const spec = sparklineSpec(period)
    const totalsByProject    = new Map() /* project_key -> [totals, ...] */
    const sparklineByProject = new Map() /* project_key -> Map<time_key, metrics> */
    for (const proj of orderedProjects) {
      totalsByProject.set(proj.project_key, [])
      sparklineByProject.set(proj.project_key, new Map())
    }

    let failedSources = 0
    await mapLimit(dsRows, GA4_OVERVIEW_CONCURRENCY, async (ds) => {
      const auth = authById.get(ds.auth_id)
      const accessToken = tokenByAuthId.get(ds.auth_id)
      const result = await fetchOneTotals(db, ds, auth, accessToken, range, spec)
      if (!result) { failedSources++; return }
      if (!totalsByProject.has(ds.project_key)) return
      totalsByProject.get(ds.project_key).push(result.totals)
      mergeTimeline(sparklineByProject.get(ds.project_key), result.sparkline)
    })

    /* ---- 所有项目先共用同一时间轴，再补 0 / 分桶 ---- */
    const sparklineLabels = collectTimelineLabels(sparklineByProject.values())
    const projectSparkline = (projectKey) => timelineValues(
      sparklineByProject.get(projectKey),
      sparklineLabels,
      'screenPageViews',
      spec.bucketDays,
    )

    /* ---- 按项目聚合 ---- */
    const out = orderedProjects.map((proj) => ({
      project_key: proj.project_key,
      name:        proj.name,
      logo_url:    proj.logo_url || '',
      site_url:    proj.site_url || '',
      metrics:     pickOutput(aggregateMetrics(totalsByProject.get(proj.project_key) || [])),
      sparkline:   projectSparkline(proj.project_key),
    }))

    /* ---- 跨项目 totals + sparkline 累加 ---- */
    const allTotals = []
    for (const arr of totalsByProject.values()) allTotals.push(...arr)
    const totals = pickOutput(aggregateMetrics(allTotals))

    const totalTimeline = new Map()
    for (const timeline of sparklineByProject.values()) mergeTimeline(totalTimeline, timeline)
    const totalSparkline = timelineValues(
      totalTimeline,
      sparklineLabels,
      'screenPageViews',
      spec.bucketDays,
    )

    const payload = { period, projects: out, totals, sparkline: totalSparkline, partial: failedSources > 0 }
    console.info('[metrics/overview] cache_miss_done:', {
      period,
      ds_count: dsRows.length,
      project_count: orderedProjects.length,
      auth_count: authRows.length,
      ms: Date.now() - startedAt,
    })
    return payload
  }
  return reqSuccess(await loadOverviewCache({
    event, db, projectId: user.project_id, cacheKey,
    refresh: query.refresh === '1', build,
  }))
})

/* ===================================================================
 *  单 ds 拉 totals + sparkline: 同一次 runReport 拿全 (零额外 GA4 调用)
 *
 *  GA4 一次请求带 dimensions: [spec.ga4Dim] + metricAggregations: ['TOTAL']
 *  → response 同时含 totals[0] (跨日累加) 和 rows[] (按 dim 分组明细);
 *    extractTotals 走 totals[0], extractSparkline 走 rows[].
 *
 *  错误降级:
 *    401 → markAuthInvalid (status=99) 让前端弹"重新授权"
 *    503 → 仅 log "rate_limited", 不向上抛
 *    其它 → log raw response
 * =================================================================== */
async function fetchOneTotals(db, ds, auth, accessToken, range, spec) {
  if (!auth || auth.status !== 1 || !accessToken) return null
  try {
    const report = await runReport({
      accessToken,
      propertyId: ds.resource_id,
      startDate:  range.startDate,
      endDate:    range.endDate,
      metrics:    OVERVIEW_METRICS,
      dimensions: [spec.ga4Dim],     /* 多带 dim 让 rows 按日/小时/月分组 */
      limit:      400,               /* 6m 拉 ~180 行, 留余量 */
    })
    return {
      totals:    extractTotals(report, OVERVIEW_METRICS),
      sparkline: extractSparkline(report),
    }
  } catch (err) {
    if (err?.statusCode === 401) {
      await markAuthInvalid(db, auth.id)
      console.error('[metrics/overview] auth invalidated:', { auth_id: auth.id, resource_id: ds.resource_id, raw: err?.data })
    } else if (err?.statusCode === 503) {
      console.warn('[metrics/overview] rate_limited (skipped):', { resource_id: ds.resource_id })
    } else {
      console.error('[metrics/overview] runReport error:', {
        status:      err?.statusCode,
        message:     err?.message,
        resource_id: ds.resource_id,
        ga4_raw:     err?.data,
      })
    }
    return null
  }
}

/* ---- 授权 token 单点解析: 同 auth 多 property 只做一次, 防止并发 refresh 自撞 ---- */
async function resolveAccessToken(db, auth, jwtSecret, siteConfig) {
  if (!auth || auth.status !== 1) return null
  try {
    return await getAccessToken(db, auth, jwtSecret, siteConfig)
  } catch {
    return null /* getAccessToken 失败时已自行置 status=99 */
  }
}

/* ---- 仅保留输出字段 (sessions 是辅助加权用, 不出参) ---- */
function pickOutput(merged) {
  const out = {}
  for (const k of OUTPUT_FIELDS) out[k] = merged?.[k] || 0
  return out
}
