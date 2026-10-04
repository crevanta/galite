/* ===========================================================
   useDataSources - 数据源授权管理
   职责: 列表 / 跳 OAuth / 解除 / 拉资源
   设计: OAuth 是浏览器跳转 (window.location), 不是 fetch
         resources 按 authId 缓存, 切账号时不重复拉
   核心: 跨页面共享 list 状态, MountResourceModal 与 data-sources 页同源
   =========================================================== */

import { projectSnapshotCache } from '~/utils/project-snapshot'

export function useDataSources() {

  const api = useApi()

  /* ---- 单例状态 ---- */
  const list = useState('galite:data-sources', () => [])
  const loading = useState('galite:data-sources-loading', () => false)
  const fetched = useState('galite:data-sources-fetched', () => false)

  /* ---- 资源缓存: authId -> { provider, account_email, resources } ---- */
  const resourceCache = useState('galite:resource-cache', () => ({}))

  /* ===========================================================
     fetchList - 拉当前用户全部已授权账号
     可选 provider 过滤 (?provider=ga4)
     =========================================================== */

  async function fetchList(provider) {
    loading.value = true
    try {
      const url = provider
        ? `/api/data-sources/list?provider=${encodeURIComponent(provider)}`
        : '/api/data-sources/list'
      const res = await api.get(url)
      if (res?.code === 200) {
        list.value = Array.isArray(res.data) ? res.data : (res.data?.list || [])
        fetched.value = true
      }
      return res
    } finally {
      loading.value = false
    }
  }

  /* ===========================================================
     connect - 跳 OAuth 授权 (整页跳转)
     return_to 默认当前页, 授权完成后回来
     mode='extended' 升级 scope 含 analytics.edit (创建 GA4 property 必需)
     =========================================================== */

  function connect(provider, returnTo, mode = 'basic') {
    if (typeof window === 'undefined') return
    const target = returnTo || window.location.pathname
    const params = new URLSearchParams({ return_to: target })
    if (mode === 'extended') params.set('mode', 'extended')
    projectSnapshotCache().clear()
    window.location.href = `/api/data-sources/oauth/${provider}?${params.toString()}`
  }

  /* ===========================================================
     connectApiKeyProvider - API Key 型 provider 连接
     目前用于 Bing Webmaster; 返回后调用方自行 toast + 刷新列表.
     =========================================================== */

  async function connectApiKeyProvider(provider, payload) {
    const res = await api.post(`/api/data-sources/${provider}/api-key`, payload || {})
    if (res?.code === 200) {
      await fetchList()
      invalidateResources()
    }
    return res
  }

  /* ===========================================================
     fetchConfig - 读取某授权的可编辑配置
     目前用于 Bing API Key 编辑弹窗，按需读取明文 key.
     =========================================================== */

  async function fetchConfig(authId) {
    return api.get(`/api/data-sources/${authId}/config`)
  }

  /* ===========================================================
     disconnect - 解除授权 (软删 status=97)
     =========================================================== */

  async function disconnect(authId) {
    const res = await api.post(`/api/data-sources/${authId}/delete`, {})
    if (res?.code === 200) await fetchList()
    return res
  }

  /* ===========================================================
     sync - 主动同步该数据源下的所有 properties → 本地项目
     OAuth 回调内部已自动 sync 一次 (跳过已挂载), 这里走 overwriteExisting=true:
     已挂载项目的 name/site_url/meta 也用 GA 远端覆盖, 适用于:
       - GA Console 改了 property 显示名
       - 改了 webStream defaultUri
       - 新增了 property (跟自动 sync 同效果)
     成功后清 resourceCache 让 list 重新拉
     =========================================================== */

  async function sync(authId) {
    const res = await api.post(`/api/data-sources/${authId}/sync`, {})
    if (res?.code === 200) invalidateResources(authId)
    return res
  }

  /* ===========================================================
     fetchResources - 拉某账号下可挂载的资源 (GA4 properties 等)
     带本地缓存, force=true 时绕过
     =========================================================== */

  async function fetchResources(authId, force) {
    if (!force && resourceCache.value[authId]) {
      return { code: 200, data: resourceCache.value[authId] }
    }
    const res = await api.get(`/api/data-sources/${authId}/resources`)
    if (res?.code === 200) {
      resourceCache.value = { ...resourceCache.value, [authId]: res.data }
    }
    return res
  }

  /* ===========================================================
     invalidateResources - 解除挂载或 token 失效后清除缓存
     =========================================================== */

  function invalidateResources(authId) {
    if (!authId) {
      resourceCache.value = {}
      return
    }
    const next = { ...resourceCache.value }
    delete next[authId]
    resourceCache.value = next
  }

  return {
    list,
    loading,
    fetched,
    fetchList,
    connect,
    connectApiKeyProvider,
    fetchConfig,
    disconnect,
    sync,
    fetchResources,
    invalidateResources,
  }
}
