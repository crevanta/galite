<template>
  <!-- ============================================================
       Integrations - 集成 (面向站长视角)
       - 不分 provider tabs, 所有已接入账号统一卡片网格展示
       - GA4 / GSC 通过 Google OAuth 接入
       - Bing 通过 API Key 接入
       --
       注意: 用户视角术语 = "集成 / 接入 / 连接", 内部实体仍叫
             data_source_auth (schema/api 不动), 这是 SaaS 行业常见的
             "外显概念 ≠ 内部实体名" 模式
       ============================================================ -->
  <div class="px-6 py-6 lg:px-10">
    <!-- ============ Header (ga-lite 紧凑风) ============ -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-xl font-bold text-gray-900">{{ $t('integrations.title') }}</h1>
      <button
        v-if="userStore.user && providers.length"
        type="button"
        :disabled="checkingGoogleConfig"
        class="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-text hover:opacity-90"
        @click="onConnect"
      >
        <NuxtIcon name="ri:add-line" class="size-4" />
        {{ $t('integrations.connect_new') }}
      </button>
    </div>

    <!-- ---- 登录用户加载中: 兜底窗口 (SSR 预拉失败 → client onMounted 补拉) ---- -->
    <div v-if="isLoggedIn && !fetched" class="mt-10 text-center text-sm text-gray-400">
      {{ $t('common.loading') }}
    </div>

    <!-- ---- 登录用户空态: 必须 fetched 后才能判, 不然 SSR 失败窗口会误闪 ---- -->
    <EmptyState
      v-else-if="isLoggedIn && fetched && !list.length"
      class="mt-10"
      :title="$t('integrations.empty')"
      :description="$t('integrations.empty_desc')"
      :cta-label="$t('integrations.connect_new')"
      @cta="onConnect"
    />

    <!-- ---- 卡片网格 ---- -->
    <ul
      v-else-if="isLoggedIn"
      class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
        <li
          v-for="auth in list"
          :key="auth.id"
          class="group overflow-hidden rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40"
        >
          <!-- ============ Header: provider 图标 + provider 名 + 右上角操作 ============ -->
          <div class="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <img
                v-if="providerAsset(auth.provider)"
                :src="providerAsset(auth.provider)"
                class="size-5 shrink-0"
                alt=""
              />
              <NuxtIcon
                v-else
                :name="providerIcon(auth.provider)"
                class="size-5 shrink-0 text-gray-500"
              />
              <h3 class="truncate text-sm font-medium text-gray-900">
                {{ providerLabel(auth.provider) }}
              </h3>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <button
                v-if="auth.provider === 'bing'"
                v-tooltip="$t('common.edit')"
                type="button"
                :disabled="loadingBingConfigId === auth.id"
                class="flex size-6 shrink-0 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60 md:opacity-0 md:group-hover:opacity-100"
                @click="editBingConfig(auth)"
              >
                <NuxtIcon
                  :name="loadingBingConfigId === auth.id ? 'ri:loader-4-line' : 'ri:edit-line'"
                  :class="['size-4', loadingBingConfigId === auth.id ? 'animate-spin' : '']"
                />
              </button>
              <!-- 同步: 已实现 listProperties 的 provider + status=1 显示 -->
              <button
                v-if="['ga4', 'gsc', 'bing'].includes(auth.provider) && auth.status === 1"
                v-tooltip="$t('integrations.sync_tip')"
                type="button"
                :disabled="syncingId === auth.id"
                class="flex size-6 shrink-0 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60 md:opacity-0 md:group-hover:opacity-100"
                @click="onSync(auth)"
              >
                <NuxtIcon
                  :name="syncingId === auth.id ? 'ri:loader-4-line' : 'ri:refresh-line'"
                  :class="['size-4', syncingId === auth.id ? 'animate-spin' : '']"
                />
              </button>
              <button
                v-tooltip="$t('integrations.disconnect')"
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-red-50 hover:text-red-500 md:opacity-0 md:group-hover:opacity-100"
                @click="askDisconnect(auth)"
              >
                <NuxtIcon name="ri:link-unlink" class="size-4" />
              </button>
            </div>
          </div>

          <!-- ============ 内容: 用户头像+名字 / 邮箱 / (失效或 scope 横幅) ============ -->
          <div class="space-y-2 px-4 py-3">
            <div class="flex items-center gap-2.5">
              <img
                v-if="auth.account_avatar"
                :src="auth.account_avatar"
                class="size-8 shrink-0 rounded-full"
                referrerpolicy="no-referrer"
                alt=""
              />
              <div
                v-else
                class="flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-500"
              >
                {{ (auth.account_name || auth.account_email || '?').slice(0, 1).toUpperCase() }}
              </div>
              <div class="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                {{ auth.account_name || auth.account_email }}
              </div>
            </div>
            <!-- 邮箱行 + 异常警告图标 (status=99 红 / scope 不足 黄)
                 警告图标即按钮: hover 浮 tooltip 说明, click 触发重连 -->
            <div class="flex items-center gap-1.5">
              <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{ auth.account_email }}</span>
              <button
                v-if="auth.status === 99"
                v-tooltip="$t('integrations.token_expired_tip')"
                type="button"
                class="flex size-5 shrink-0 items-center justify-center rounded text-red-500 hover:bg-red-50"
                @click="connectByProvider(auth.provider)"
              >
                <NuxtIcon name="ri:error-warning-fill" class="size-4" />
              </button>
              <button
                v-else-if="needsScopeUpgrade(auth)"
                v-tooltip="$t('integrations.scope_upgrade_tip')"
                type="button"
                class="flex size-5 shrink-0 items-center justify-center rounded text-amber-500 hover:bg-amber-50"
                @click="upgradeScope(auth.provider)"
              >
                <NuxtIcon name="ri:alert-line" class="size-4" />
              </button>
            </div>
          </div>
        </li>
      </ul>

    <!-- ============ 选数据源弹窗 (enabled 数据源 ≥ 2 时启用)
         双层选择: ① 权限范围 (只读 / 读写)  ② provider (GA4 / GSC ...)
         点击 provider 卡片 → 带上权限模式整页跳 OAuth ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="chooserVisible"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="chooserVisible = false"
        >
          <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <!-- ============ 标题: 唯一文字主体, 副标题已删 ============ -->
            <h3 class="text-lg font-bold text-gray-900">{{ $t('integrations.choose_provider') }}</h3>

            <!-- ============ 权限选择: 横向 radio (圆点 + 标签)
                 - 单行紧凑, 每个选项前面带 radio 圆点
                 - 选中态: 文字加深 + 圆点实心, 视觉一眼区分
                 - ⓘ tooltip 保留 hint 信息但不抢戏 ============ -->
            <div class="mt-3 flex items-center gap-4 text-xs">
              <button
                v-for="opt in permissionOptions"
                :key="opt.value"
                type="button"
                :class="[
                  'flex items-center gap-1.5 font-medium transition-colors',
                  permissionMode === opt.value
                    ? 'text-gray-900'
                    : 'text-gray-400 hover:text-gray-600',
                ]"
                :aria-pressed="permissionMode === opt.value"
                @click="permissionMode = opt.value"
              >
                <!-- 单选圆点: 选中态实心, 未选中空环 -->
                <span
                  :class="[
                    'flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    permissionMode === opt.value ? 'border-primary' : 'border-gray-300',
                  ]"
                >
                  <span
                    v-if="permissionMode === opt.value"
                    class="size-1.5 rounded-full bg-primary"
                  />
                </span>
                {{ opt.label }}
              </button>
              <button
                type="button"
                v-tooltip="permissionMode === 'extended'
                  ? $t('integrations.permission.readwrite_hint')
                  : $t('integrations.permission.readonly_hint')"
                class="flex size-4 items-center justify-center rounded text-gray-300 hover:text-gray-500"
                :aria-label="$t('integrations.permission.label')"
              >
                <NuxtIcon name="ri:information-line" class="size-3.5" />
              </button>
            </div>

            <!-- ============ Provider 列表 (主体, 视觉重量集中在这) ============ -->
            <div class="mt-5 grid grid-cols-1 gap-2">
              <button
                v-for="p in providers"
                :key="p.id"
                type="button"
                class="flex items-center gap-3 rounded-xl border border-gray-200 p-3 text-left transition-colors hover:border-primary hover:bg-primary/5"
                @click="connectByProvider(p.id, permissionMode)"
              >
                <img
                  v-if="p.iconAsset"
                  :src="p.iconAsset"
                  class="size-5 shrink-0"
                  alt=""
                />
                <NuxtIcon
                  v-else
                  :name="p.iconRi"
                  class="size-5 shrink-0 text-gray-700"
                />
                <span class="text-sm font-medium text-gray-800">{{ p.label }}</span>
              </button>
            </div>
            <div class="mt-6 flex justify-end">
              <button
                type="button"
                class="rounded-full px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
                @click="chooserVisible = false"
              >
                {{ $t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <BingApiKeyModal
      :visible="bingApiKeyVisible"
      :pending="bingApiKeyPending"
      :auth="editingBingAuth"
      @close="closeBingApiKeyModal"
      @save="saveBingApiKey"
    />

    <!-- ============ 解除授权确认 ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="disconnecting"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="disconnecting = null"
        >
          <div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 class="text-lg font-bold text-red-600">{{ $t('integrations.disconnect') }}</h3>
            <p class="mt-2 text-sm text-gray-500">
              {{ $t('integrations.disconnect_confirm', {
                provider: providerLabel(disconnecting.provider),
                email: disconnecting.account_email,
              }) }}
            </p>
            <div class="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                class="rounded-full px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
                @click="disconnecting = null"
              >
                {{ $t('common.cancel') }}
              </button>
              <button
                type="button"
                class="rounded-full bg-red-500 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                :disabled="disconnectingPending"
                @click="confirmDisconnect"
              >
                {{ $t('integrations.disconnect') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
definePageMeta({ layout: 'app' })

/* ============================================================
   /integrations - 集成 (站长视角)
   设计:
     - 卡片网格平铺所有已接入账号 (不区分 provider)
     - enabled providers === 1 -> 直接跳 OAuth
     - enabled providers >= 2  -> 弹「选账号类型」弹窗
   URL 参数:
     ?connected=ga4   -> 提示成功
     ?error=oauth_failed -> 提示失败
   ============================================================ */

import { computed, onMounted, ref, watch } from 'vue'
import EmptyState from '~/components/layout/EmptyState.vue'
import BingApiKeyModal from '~/components/integrations/BingApiKeyModal.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { isLoggedIn } = useAuth()
const userStore = useUserStore()

/* ---- 浏览器标签标题: "集成 · account@example.com - GA Lite" ---- */
const pageTitle = useAccountTitle(() => t('integrations.title'))
useHead({ title: () => pageTitle.value })
const openAccount = inject('openAccount', () => {})
const api = useApi()

const { list, loading, fetched, fetchList, connect, connectApiKeyProvider, fetchConfig, disconnect, sync } = useDataSources()
/* useProjects.list 是跨页面 useState 共享缓存, 同步后必须主动刷新,
   否则 /projects 卡片会用 SPA 内存里的旧 name/site_url 显示 */
const { fetchList: refetchProjects } = useProjects()

/* ============================================================
   SSR 预拉 list (setup 顶层 await, 仅 server 阶段执行)
   --
   目的: 首屏直接渲染真实卡片网格, 不再闪一下 "Loading..." 文案.
        cookie 由 useApi 自动透传给 nitro, server middleware 解析登录态,
        useState 把 SSR 拉到的 list/fetched 自动水合到 client.
   失败静默: SSR 网络抖动时回退到 client onMounted 补拉, 不阻塞渲染.
   ============================================================ */
if (import.meta.server && isLoggedIn.value && !fetched.value) {
  await fetchList().catch(() => {})
}

const { show: showToast } = useToast()

/* ---- Provider 注册表 (与后端 utils/providers/index.js 对齐)
 *  iconAsset: /public/images/icon/ 下的实际 svg 路径 (左上角 logo)
 *  iconRi:    fallback nuxt-icon 名 (provider chooser 弹窗 / 老用法兼容)
 */
const providers = computed(() => [
  { id: 'ga4',  label: t('integrations.provider.ga4'),  authMode: 'oauth',   iconAsset: '/images/icon/google-analytics.svg',      iconRi: 'ri:google-fill' },
  { id: 'gsc',  label: t('integrations.provider.gsc'),  authMode: 'oauth',   iconAsset: '/images/icon/google-search-console.svg', iconRi: 'ri:search-line' },
  { id: 'bing', label: t('integrations.provider.bing'), authMode: 'api_key', iconAsset: '/images/icon/bing-webmaster.svg',        iconRi: 'ri:search-line' },
])

function providerLabel(id) {
  return providers.value.find((p) => p.id === id)?.label || id
}

function providerIcon(id) {
  return providers.value.find((p) => p.id === id)?.iconRi || 'ri:plug-line'
}

function providerAsset(id) {
  return providers.value.find((p) => p.id === id)?.iconAsset || ''
}

/* ---- scope 升级判定:
 *   当前 GA4 新建网站流程依赖 analytics.edit, 老用户 scope 不含
 *   该项时, 在卡片里弹黄 banner 引导重连. 仅对 status=1 的 ga4
 *   账号生效, status=99 走红 banner 优先.
 *   --- */
const REQUIRED_GA4_EDIT_SCOPE = 'https://www.googleapis.com/auth/analytics.edit'
const LEGACY_GA4_FULL_SCOPE = 'https://www.googleapis.com/auth/analytics'
function needsScopeUpgrade(auth) {
  if (!auth || auth.provider !== 'ga4') return false
  if (auth.status !== 1) return false
  const scopes = new Set(String(auth.scope || '').split(/\s+/).filter(Boolean))
  return !scopes.has(REQUIRED_GA4_EDIT_SCOPE) && !scopes.has(LEGACY_GA4_FULL_SCOPE)
}

/* ===========================================================
   连接流程:
     - 单数据源    → 直跳 OAuth (默认 basic 只读)
     - 多数据源    → 弹 chooser, 让用户先选权限范围 + provider
     - 升级 scope → 现有授权直接走 extended (跳过 chooser, 已隐含目标 provider)
   --
   permissionMode 真相源 (basic = 只读 / extended = 读写):
     - 与后端 oauth/[provider].get.js 的 mode query 同名对齐
     - 默认 basic, 用户主动切换 extended (保守授权原则)
   =========================================================== */
const chooserVisible = ref(false)
const permissionMode = ref('basic')
const bingApiKeyVisible = ref(false)
const bingApiKeyPending = ref(false)
const editingBingAuth = ref(null)
const loadingBingConfigId = ref(null)
const checkingGoogleConfig = ref(false)
const googleOauthConfigured = ref(null)

const permissionOptions = computed(() => [
  { value: 'basic',    label: t('integrations.permission.readonly') },
  { value: 'extended', label: t('integrations.permission.readwrite') },
])

async function ensureGoogleOauthConfigured(force = false) {
  if (!force && googleOauthConfigured.value === true) return true
  checkingGoogleConfig.value = true
  try {
    const res = await api.get('/api/user/settings')
    googleOauthConfigured.value = Boolean(res?.data?.google_oauth_configured)
  } catch {
    googleOauthConfigured.value = false
  } finally {
    checkingGoogleConfig.value = false
  }
  if (googleOauthConfigured.value) return true
  chooserVisible.value = false
  openAccount('google')
  showToast(t('integrations.google_config_required'), { type: 'info' })
  return false
}

async function onConnect() {
  if (!await ensureGoogleOauthConfigured(true)) return
  permissionMode.value = 'basic' /* 每次打开 chooser 重置为安全默认 */
  if (providers.value.length === 1) {
    connectByProvider(providers.value[0].id, 'basic')
    return
  }
  chooserVisible.value = true
}

async function connectByProvider(providerId, mode = 'basic') {
  chooserVisible.value = false
  const provider = providers.value.find((p) => p.id === providerId)
  if (provider?.authMode === 'api_key') {
    editingBingAuth.value = null
    bingApiKeyVisible.value = true
    return
  }
  if (!await ensureGoogleOauthConfigured()) return
  connect(providerId, '/integrations', mode)
}

async function editBingConfig(auth) {
  if (!auth || auth.provider !== 'bing' || loadingBingConfigId.value) return
  loadingBingConfigId.value = auth.id
  try {
    const res = await fetchConfig(auth.id)
    if (res?.code === 200) {
      editingBingAuth.value = { ...auth, ...(res.data || {}) }
      bingApiKeyVisible.value = true
    } else {
      showToast(res?.msg || t('integrations.connect_error'), { type: 'error' })
    }
  } catch (err) {
    showToast(err?.message || t('integrations.connect_error'), { type: 'error' })
  } finally {
    loadingBingConfigId.value = null
  }
}

function closeBingApiKeyModal() {
  if (bingApiKeyPending.value) return
  bingApiKeyVisible.value = false
  editingBingAuth.value = null
}

async function saveBingApiKey(payload) {
  if (bingApiKeyPending.value) return
  bingApiKeyPending.value = true
  try {
    const res = await connectApiKeyProvider('bing', payload)
    if (res?.code === 200) {
      bingApiKeyVisible.value = false
      editingBingAuth.value = null
      showToast(t('integrations.connected_toast', { provider: providerLabel('bing') }), { type: 'success' })
      const syncedCount = Number(res.data?.synced || 0)
      if (syncedCount > 0) {
        showToast(t('integrations.synced_toast', syncedCount, { count: syncedCount }), { type: 'success' })
      }
      await Promise.all([
        fetchList(),
        refetchProjects().catch(() => {}),
      ])
    } else {
      showToast(res?.msg || t('integrations.connect_error'), { type: 'error' })
    }
  } catch (err) {
    showToast(err?.message || t('integrations.connect_error'), { type: 'error' })
  } finally {
    bingApiKeyPending.value = false
  }
}

/* ---- 升级 scope: 卡片上"权限不足"按钮触发, 现有授权追加 edit/write
        GA4 = analytics.edit  /  GSC = webmasters (含读写) ---- */
async function upgradeScope(providerId) {
  if (!await ensureGoogleOauthConfigured(true)) return
  connect(providerId, '/integrations', 'extended')
}

/* ---- 主动同步: 完整拉取远端资源，更新现有挂载并清理远端已删除项 ----
       loading 状态用 syncingId 单值 (同一时刻只能同步一个), 不阻塞 disconnect 等其他操作.
       完成后 fetchList() 让卡片 mounted_count 等元信息刷新. */
const syncingId = ref(null)

async function onSync(auth) {
  if (syncingId.value) return
  syncingId.value = auth.id
  try {
    const res = await sync(auth.id)
    if (res?.code === 200) {
      const { created, updated, removed, total } = res.data || {}
      showToast(
        t('integrations.sync_success', {
          created: created || 0,
          updated: updated || 0,
          removed: removed || 0,
          total: total || 0,
        }),
        { type: 'success' },
      )
      /* 同步成功后双刷:
         - fetchList()       本页 data_sources 卡片状态 (mounted_count 等)
         - refetchProjects() 跨页面 useProjects.list 共享缓存 (新 name/site_url),
                             让用户切回 /projects 直接看到最新, 无需手动 RefreshButton */
      await Promise.all([
        fetchList(),
        refetchProjects().catch(() => {}),  /* 失败静默, 不阻塞 sync 成功反馈 */
      ])
    } else {
      const syncErrors = {
        sync_incomplete: 'integrations.sync_failed',
        ga4_admin_api_disabled: 'integrations.ga4_admin_api_disabled',
        gsc_api_disabled: 'integrations.gsc_api_disabled',
      }
      const message = syncErrors[res?.msg]
        ? t(syncErrors[res.msg])
        : (res?.msg || t('integrations.sync_failed'))
      showToast(message, { type: 'error' })
    }
  } catch (err) {
    showToast(err?.message || t('integrations.sync_failed'), { type: 'error' })
  } finally {
    syncingId.value = null
  }
}

/* ---- 解除授权 ---- */
const disconnecting = ref(null)
const disconnectingPending = ref(false)

function askDisconnect(auth) {
  disconnecting.value = auth
}

async function confirmDisconnect() {
  if (!disconnecting.value || disconnectingPending.value) return
  disconnectingPending.value = true
  try {
    const res = await disconnect(disconnecting.value.id)
    if (res?.code === 200) {
      showToast(t('integrations.disconnect_success'), { type: 'success' })
      disconnecting.value = null
    } else {
      showToast(res?.msg || t('integrations.disconnect_failed'), { type: 'error' })
    }
  } catch (err) {
    showToast(err?.message || t('integrations.disconnect_failed'), { type: 'error' })
  } finally {
    disconnectingPending.value = false
  }
}

/* ---- URL 参数响应: connected= / synced= / oauth_cancelled= / oauth_failed= / error= ----
       三类回跳态:
         connected         成功 — 绿色 toast + 可能附"已同步 N 个网站"
         oauth_cancelled   用户主动取消 — 中性 info toast (不刺眼)
         oauth_failed/error 协议/配置异常 — 红色 error toast
       (error 兼容老链接, 新 callback 已用 oauth_failed) */
function consumeUrlState() {
  const q = route.query
  if (q.connected) {
    showToast(t('integrations.connected_toast', { provider: providerLabel(String(q.connected)) }), { type: 'success' })
    const syncedCount = Number(q.synced || 0)
    if (syncedCount > 0) {
      showToast(t('integrations.synced_toast', syncedCount, { count: syncedCount }), { type: 'success' })
    }
    /* 重连可能只删除了远端已消失的站点，created=0 也必须刷新项目集合。 */
    fetchList()
    refetchProjects().catch(() => {})
    router.replace({ query: {} })
  } else if (q.oauth_cancelled) {
    showToast(t('integrations.oauth_cancelled'), { type: 'info' })
    router.replace({ query: {} })
  } else if (q.oauth_failed || q.error) {
    showToast(t('integrations.connect_error'), { type: 'error' })
    router.replace({ query: {} })
  }
}

watch(() => route.query, consumeUrlState, { immediate: false })

onMounted(async () => {
  if (!isLoggedIn.value) return
  await fetchList()
  consumeUrlState()
})
</script>
