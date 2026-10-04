/* ===================================================================
 * Search overview 聚合器
 *
 *  用于:
 *    /api/metrics/overview/bing
 *    /api/metrics/overview/search
 * =================================================================== */

import { and, eq, inArray } from 'drizzle-orm'
import { project_list, project_data_source, data_source_auth } from '../database/schema'
import { MetricsPeriod, RecordStatus } from './constants'
import { isValidPeriod } from './period'
import { selectInBatches, useDb } from './db'
import { providerOf } from './providers'
import { getProviderCredential } from './data-source-token'
import { buildCacheKey } from './metrics-cache'
import { loadOverviewCache } from './overview-cache'
import { getJwtSecret, getSiteConfig, markAuthInvalid } from './metrics-helpers'
import { mapLimit } from './map-limit'
import { mergeProviderMap, mergeSearchMetrics, pickSearchOutput } from './search-metrics'
import { periodToRange } from './providers/gsc'
import { addTimelinePoint, collectTimelineLabels, mergeTimeline, timelineValues } from './sparkline'

const OVERVIEW_CONCURRENCY = 6
const SPARKLINE_SPEC = {
  today:     { dim: 'date', bucketDays: 0 },
  yesterday: { dim: 'date', bucketDays: 0 },
  '7days':   { dim: 'date', bucketDays: 0 },
  '28days':  { dim: 'date', bucketDays: 0 },
  '90days':  { dim: 'date', bucketDays: 7 },
  '6months': { dim: 'date', bucketDays: 7 },
  '1year':   { dim: 'date', bucketDays: 30 },
}

function specOf(period) {
  return SPARKLINE_SPEC[period] || SPARKLINE_SPEC['7days']
}

function extractDateKey(row) {
  return String(Array.isArray(row?.keys) ? row.keys[0] || '' : '')
}

function extractSparklineTimeline(report) {
  const timeline = new Map()
  for (const row of (Array.isArray(report?.rows) ? report.rows : [])) {
    addTimelinePoint(timeline, extractDateKey(row), {
      clicks: row.clicks,
      impressions: row.impressions,
    })
  }
  return timeline
}

function ensureProviderBucket(map, projectKey, provider) {
  const bucket = map.get(projectKey) || {}
  if (!bucket[provider]) bucket[provider] = []
  map.set(projectKey, bucket)
  return bucket[provider]
}

function ensureProviderTimeline(map, projectKey, provider) {
  const bucket = map.get(projectKey) || {}
  if (!bucket[provider]) bucket[provider] = new Map()
  map.set(projectKey, bucket)
  return bucket[provider]
}

function shapeProviderSparklines(providerTimelines, labels, bucketDays) {
  return Object.fromEntries(Object.entries(providerTimelines || {}).map(([provider, timeline]) => [
    provider,
    {
      clicks: timelineValues(timeline, labels, 'clicks', bucketDays),
      impressions: timelineValues(timeline, labels, 'impressions', bucketDays),
    },
  ]))
}

export async function buildSearchOverview(event, {
  providers,
  cachePrefix = 'search',
  period = MetricsPeriod.LAST_7_DAYS,
}) {
  const user = requireAuth(event)
  if (!isValidPeriod(period)) return { error: 'invalid_period' }

  const providerList = Array.isArray(providers) ? providers.filter(Boolean) : []
  const db = await useDb(event)
  const jwtSecret = getJwtSecret(event)
  const siteConfig = getSiteConfig(event)
  const cacheKey = buildCacheKey([cachePrefix, 'overview', 'user', user.union_id, 'all', period])
  const build = async () => {

    if (!providerList.length) {
      const empty = emptyPayload(period)
      return empty
    }

    const allDsRows = await db.select().from(project_data_source)
      .where(and(
        eq(project_data_source.project_id, user.project_id),
        eq(project_data_source.union_id, user.union_id),
        inArray(project_data_source.provider, providerList),
        eq(project_data_source.status, RecordStatus.ACTIVE),
      ))
    const dsRows = allDsRows

    if (!dsRows.length) {
      const empty = emptyPayload(period)
      return empty
    }

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
    const credentialByAuth = new Map()

    await mapLimit(authRows, OVERVIEW_CONCURRENCY, async (auth) => {
      try {
        credentialByAuth.set(auth.id, await getProviderCredential(db, auth, jwtSecret, siteConfig))
      } catch {
        credentialByAuth.set(auth.id, null)
      }
    })

    const spec = specOf(period)
    const range = periodToRange(period)
    const totalsByProject = new Map()
    const providerTotalsByProject = new Map()
    const timelineByProject = new Map()
    const providerTimelineByProject = new Map()

    for (const project of orderedProjects) {
      totalsByProject.set(project.project_key, [])
      timelineByProject.set(project.project_key, new Map())
    }

    let failedSources = 0
    await mapLimit(dsRows, OVERVIEW_CONCURRENCY, async (ds) => {
      if (!projectByKey.has(ds.project_key)) return
      const auth = authById.get(ds.auth_id)
      const credential = credentialByAuth.get(ds.auth_id)
      const result = await fetchOneSearchSource(db, ds, auth, credential, range, spec)
      if (!result) { failedSources++; return }

      totalsByProject.get(ds.project_key).push(result.totals)
      ensureProviderBucket(providerTotalsByProject, ds.project_key, ds.provider).push(result.totals)
      mergeTimeline(timelineByProject.get(ds.project_key), result.timeline)
      mergeTimeline(
        ensureProviderTimeline(providerTimelineByProject, ds.project_key, ds.provider),
        result.timeline,
      )
    })

    const sparklineLabels = collectTimelineLabels(timelineByProject.values())

    const out = orderedProjects.map((project) => {
      const providerTotals = providerTotalsByProject.get(project.project_key) || {}
      const timeline = timelineByProject.get(project.project_key)
      return {
        project_key: project.project_key,
        name: project.name,
        logo_url: project.logo_url || '',
        site_url: project.site_url || '',
        metrics: pickSearchOutput(mergeSearchMetrics(totalsByProject.get(project.project_key) || [])),
        providers: mergeProviderMap(providerTotals),
        sparkline_clicks: timelineValues(timeline, sparklineLabels, 'clicks', spec.bucketDays),
        sparkline_impressions: timelineValues(timeline, sparklineLabels, 'impressions', spec.bucketDays),
        sparkline_providers: shapeProviderSparklines(
          providerTimelineByProject.get(project.project_key),
          sparklineLabels,
          spec.bucketDays,
        ),
      }
    })

    const allTotals = []
    const globalProviderTotals = {}
    const totalTimeline = new Map()
    for (const project of orderedProjects) {
      allTotals.push(...(totalsByProject.get(project.project_key) || []))
      mergeTimeline(totalTimeline, timelineByProject.get(project.project_key))
      const providerTotals = providerTotalsByProject.get(project.project_key) || {}
      for (const [provider, list] of Object.entries(providerTotals)) {
        if (!globalProviderTotals[provider]) globalProviderTotals[provider] = []
        globalProviderTotals[provider].push(...list)
      }
    }

    const payload = {
      partial: failedSources > 0,
      period,
      projects: out,
      totals: pickSearchOutput(mergeSearchMetrics(allTotals)),
      provider_totals: mergeProviderMap(globalProviderTotals),
      sparkline_clicks: timelineValues(totalTimeline, sparklineLabels, 'clicks', spec.bucketDays),
      sparkline_impressions: timelineValues(totalTimeline, sparklineLabels, 'impressions', spec.bucketDays),
    }
    return payload
  }
  return { payload: await loadOverviewCache({
    event, db, projectId: user.project_id, cacheKey,
    refresh: getQuery(event).refresh === '1', build,
  }) }
}

function emptyPayload(period) {
  return {
    period,
    projects: [],
    totals: pickSearchOutput({}),
    provider_totals: {},
    sparkline_clicks: [],
    sparkline_impressions: [],
  }
}

async function fetchOneSearchSource(db, ds, auth, credential, range, spec) {
  if (!auth || auth.status !== 1 || !credential) return null
  const provider = providerOf(ds.provider)
  try {
    const report = await provider.runReport({
      accessToken: credential,
      apiKey: credential,
      siteUrl: ds.resource_id,
      startDate: range.startDate,
      endDate: range.endDate,
      dimensions: [spec.dim],
      rowLimit: 25000,
    })
    return {
      totals: provider.extractTotals(report),
      timeline: extractSparklineTimeline(report),
    }
  } catch (err) {
    if (err?.statusCode === 401) {
      await markAuthInvalid(db, auth.id)
      console.error('[search-overview] auth invalidated:', { provider: ds.provider, auth_id: auth.id, resource_id: ds.resource_id })
    } else if (err?.statusCode === 503) {
      console.warn('[search-overview] rate_limited:', { provider: ds.provider, resource_id: ds.resource_id })
    } else {
      console.error('[search-overview] runReport error:', { provider: ds.provider, message: err?.message, resource_id: ds.resource_id })
    }
    return null
  }
}
