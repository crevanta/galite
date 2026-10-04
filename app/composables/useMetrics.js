/* ===========================================================
   useMetrics - 项目指标查询
   职责: 4 种维度 (summary / timeseries / dimension / realtime) + period 状态
   设计: 每个 useMetrics(projectKey) 独立实例, 不缓存到全局
         period 变化由调用方监听 + 主动 refetch
         projectKey 可传 string | ref | computed, 内部每次 unref 取最新值
         (详情页"站点切换"切换路由参数时同一组件复用, 必须每次实时读)
   核心: useApi 不支持 query, 这里手动拼 URL
   --
   最小 loading 时长保护: 后端走 60s metrics_cache, 命中时几毫秒返回,
     UI 从骨架到数据的跳变非常突兀 ("闪动"). 强制 loading 至少持续
     MIN_LOADING_MS, 让缓存命中和真实请求拥有同一种视觉节奏.
     哲学: 用户感知的"加载体验一致性" > 缓存的"实际快"
   =========================================================== */

import { ref, unref } from 'vue'
import { withMinLoading } from '~/utils/min-loading'

/* ---- 拼 query string (跳过 undefined; 数组形态自动展开成多值 ?f=a&f=b) ---- */
function buildQuery(params) {
  const parts = []
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null || item === '') continue
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`)
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    }
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/* ---- filters[] → URL query 数组 (跟 server/utils/filters.js 对齐) ---- */
function filtersToParam(filtersRef) {
  const arr = unref(filtersRef) || []
  if (!arr.length) return undefined
  const dataFilters = arr.filter((f) => f?.dim !== 'searchProvider')
  if (!dataFilters.length) return undefined
  return dataFilters.map((f) => `${f.dim}:${f.match}:${f.value}`)
}

export function useMetrics(projectKey, filters) {

  const api = useApi()

  /* ---- 周期状态 (默认 7days) ---- */
  const period = ref('7days')

  /* ---- 4 类查询结果 ---- */
  const summary = ref(null)
  const timeseries = ref(null)
  const dimension = ref(null)
  const realtime = ref(null)

  /* ---- 加载态分别控制, 避免相互覆盖 ---- */
  const loading = ref({
    summary: false,
    timeseries: false,
    dimension: false,
    realtime: false,
  })

  /* ===========================================================
     fetchSummary - 8 个核心指标 + previous_metrics
     =========================================================== */

  async function fetchSummary() {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.summary = v }, async () => {
      const url = `/api/metrics/${pk}/summary${buildQuery({
        period: period.value,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) summary.value = res.data
      return res
    })
  }

  /* ===========================================================
     fetchTimeseries - 时序数据 (按 metric)
     =========================================================== */

  async function fetchTimeseries(metric = 'screenPageViews') {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.timeseries = v }, async () => {
      const url = `/api/metrics/${pk}/timeseries${buildQuery({
        period: period.value,
        metric,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) timeseries.value = res.data
      return res
    })
  }

  /* ===========================================================
     fetchDimension - 维度排行 (country / channel / device / page)
     =========================================================== */

  async function fetchDimension(dim = 'country') {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.dimension = v }, async () => {
      const url = `/api/metrics/${pk}/dimension${buildQuery({
        period: period.value,
        dimension: dim,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) dimension.value = res.data
      return res
    })
  }

  /* ===========================================================
     fetchRealtime - 单项目实时
     =========================================================== */

  async function fetchRealtime() {
    const pk = unref(projectKey)
    if (!pk) return
    loading.value.realtime = true
    try {
      const res = await api.get(`/api/metrics/${pk}/realtime`)
      if (res?.code === 200 && res.data?.realtime_status !== 'error') realtime.value = res.data
      return res
    } finally {
      loading.value.realtime = false
    }
  }

  /* ===========================================================
     GSC 三个查询: 与 GA4 同款结构 (filters 透传, 后端只消费 searchQuery)
     =========================================================== */
  const gscSummary    = ref(null)
  const gscDimension  = ref(null)
  const gscTimeseries = ref(null)
  const searchDimension = ref(null)
  loading.value.gscSummary    = false
  loading.value.gscDimension  = false
  loading.value.gscTimeseries = false
  loading.value.searchDimension = false

  async function fetchGscSummary() {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.gscSummary = v }, async () => {
      const url = `/api/metrics/${pk}/gsc/summary${buildQuery({
        period: period.value,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) gscSummary.value = res.data
      return res
    })
  }

  async function fetchGscDimension(dim = 'query') {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.gscDimension = v }, async () => {
      const url = `/api/metrics/${pk}/gsc/dimension${buildQuery({
        period: period.value,
        dimension: dim,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) gscDimension.value = res.data
      return res
    })
  }

  async function fetchGscTimeseries(metric = 'impressions') {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.gscTimeseries = v }, async () => {
      const url = `/api/metrics/${pk}/gsc/timeseries${buildQuery({
        period: period.value,
        metric,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) gscTimeseries.value = res.data
      return res
    })
  }

  async function fetchSearchDimension(dim = 'query', sp = 'all') {
    const pk = unref(projectKey)
    if (!pk) return
    return withMinLoading((v) => { loading.value.searchDimension = v }, async () => {
      const url = `/api/metrics/${pk}/search/dimension${buildQuery({
        period: period.value,
        dimension: dim,
        sp,
        f: filtersToParam(filters),
      })}`
      const res = await api.get(url)
      if (res?.code === 200) searchDimension.value = res.data
      return res
    })
  }

  return {
    period,
    summary,
    timeseries,
    dimension,
    realtime,
    gscSummary,
    gscDimension,
    gscTimeseries,
    searchDimension,
    loading,
    fetchSummary,
    fetchTimeseries,
    fetchDimension,
    fetchRealtime,
    fetchGscSummary,
    fetchGscDimension,
    fetchGscTimeseries,
    fetchSearchDimension,
  }
}

/* ===========================================================
   useGlobalMetrics - 全站点聚合 (overview + realtime)
   场景: /projects 列表页 7 天浏览量, /realtime 全站点
   =========================================================== */

export function useGlobalMetrics() {

  const api = useApi()

  async function fetchOverview(period = '7days', { refresh = false } = {}) {
    return await api.get(`/api/metrics/overview${buildQuery({ period, refresh: refresh ? '1' : undefined })}`)
  }

  /* GSC 全站点摘要: 仅返"有 GSC 数据源"的项目 + 跨站 totals + 双线 sparkline */
  async function fetchOverviewGsc(period = '7days') {
    return await api.get(`/api/metrics/overview/gsc${buildQuery({ period })}`)
  }

  async function fetchOverviewBing(period = '7days') {
    return await api.get(`/api/metrics/overview/bing${buildQuery({ period })}`)
  }

  async function fetchOverviewSearch(period = '7days', { refresh = false } = {}) {
    return await api.get(`/api/metrics/overview/search${buildQuery({ period, refresh: refresh ? '1' : undefined })}`)
  }

  async function fetchRealtimeAll(period = '30min') {
    return await api.get(`/api/metrics/realtime${buildQuery({ period })}`)
  }

  return { fetchOverview, fetchOverviewGsc, fetchOverviewBing, fetchOverviewSearch, fetchRealtimeAll }
}
