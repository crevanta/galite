<script setup>
/* ============================================================
   SiteCardCombo - 双源合并卡 (GA4 + GSC 同站点)
   --
   设计意图:
   - 解决"同站点 GA4 卡和 GSC 卡分离太远"的视觉痛点
   - 共享 header (favicon + name + 三点菜单), 内部双区
       lg+   左右两半 (GA4 | GSC), 共占 col-span-2 (一张卡 = 双倍宽)
       sm-   上下两半 (GA4 / GSC), 仍占 col-span-2 但单列
   - 每半都带数据源 logo 让用户一眼分辨来源
   - 复用 SiteCard / SiteCardGsc 的格式化函数, 字段语义一致
   --
   props:
     mode='site'|'overview'
     project / overviewLabel (与单源卡同)
     ga4Metrics / ga4Sparkline
     gscMetrics / gscSparklineClicks / gscSparklineImpressions
     loading / hideNames / index
   ============================================================ */

import { computed, onMounted, onUnmounted, ref } from 'vue'
import MiniSparkline from '~/components/projects/MiniSparkline.vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'

const props = defineProps({
  mode:          { type: String,  default: 'site' },
  project:       { type: Object,  default: null },
  overviewLabel: { type: String,  default: '' },

  /* GA4 半区 */
  ga4Metrics:    { type: Object,  default: null },
  ga4Sparkline:  { type: Array,   default: () => [] },

  /* GSC 半区 */
  gscMetrics:              { type: Object, default: null },
  gscSparklineClicks:      { type: Array,  default: () => [] },
  gscSparklineImpressions: { type: Array,  default: () => [] },

  /* loading: 完整骨架 (favicon + 名字 + 两半区指标 + sparkline 全 pulse), 用于首次加载占位 */
  loading:        { type: Boolean, default: false },
  /* numberLoading: 仅指标 + sparkline pulse, 用于周期切换/刷新 (header 保持稳定不闪) */
  numberLoading:  { type: Boolean, default: false },
  /* showInstall: 三点菜单中是否展示「安装代码」项
     - 纯 GSC 项目 (未挂 GA4) 无需埋点, 父组件传 false 隐藏该按钮 */
  showInstall:   { type: Boolean, default: true },
  hideNames: { type: Boolean, default: false },
  index:     { type: Number,  default: 0 },
})

const emit = defineEmits(['edit', 'install', 'delete'])

const localePath = useLocalePath()
const { t } = useI18n()

const isOverview = computed(() => props.mode === 'overview')

/* ---- 显示名字 ---- */
const displayName = computed(() => {
  if (isOverview.value) return props.overviewLabel || t('overview.all_sites')
  if (props.hideNames) return `Site #${props.index + 1}`
  return props.project?.name || t('projects.unnamed') || '—'
})

const faviconUrl = computed(() => {
  if (isOverview.value || props.hideNames) return ''
  return resolveProjectIcon(props.project)
})

const fallbackIcon = computed(() => {
  if (isOverview.value) return 'ri:stack-line'
  if (props.hideNames)  return 'ri:eye-off-line'
  return 'ri:global-line'
})

/* ============================================================
   字段配置 (复用 SiteCard / SiteCardGsc 同款逻辑)
   ============================================================ */
/* labelColor: 指标名颜色与下方对应折线颜色一致, 让用户一眼匹配"哪条线是哪个指标"
   - GA4 sparkline 单线 = 主题色 → page_views 标签主题色
   - GSC sparkline 双线 = 蓝 + 紫 → clicks/impressions 标签同色
   - 其他指标 (visitors / duration / position) 无对应线 → 保持灰色 */
const GA4_FIELDS = [
  { key: 'totalUsers',             label: 'metrics.card.visitors',   format: 'int' },
  { key: 'screenPageViews',        label: 'metrics.card.page_views', format: 'int',     labelColor: 'var(--color-primary)' },
  { key: 'averageSessionDuration', label: 'metrics.card.engagement', format: 'duration' },
]
const GSC_FIELDS = [
  { key: 'clicks',      label: 'metrics.card.clicks',      format: 'int',     labelColor: '#4285f4' },
  { key: 'impressions', label: 'metrics.card.impressions', format: 'int',     labelColor: '#a142f4' },
  { key: 'position',    label: 'metrics.card.position',    format: 'decimal' },
]

function formatInt(v) {
  const n = Number(v) || 0
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000)        return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return n.toLocaleString()
}
function formatDuration(v) {
  const n = Number(v) || 0
  if (n < 60) return Math.round(n) + 's'
  const m = Math.floor(n / 60)
  const s = Math.round(n % 60)
  return `${m}m ${s}s`
}
function formatDecimal(v) {
  const n = Number(v) || 0
  if (n === 0) return '—'
  return n.toFixed(1)
}
function format(value, kind) {
  if (kind === 'duration') return formatDuration(value)
  if (kind === 'decimal')  return formatDecimal(value)
  return formatInt(value)
}

function buildCards(fields, metricsObj) {
  return fields.map((f) => ({
    key: f.key,
    label: t(f.label),
    labelColor: f.labelColor || '',
    has: metricsObj != null && metricsObj[f.key] !== undefined,
    display: metricsObj != null && metricsObj[f.key] !== undefined
      ? format(metricsObj[f.key], f.format)
      : '—',
  }))
}
const ga4Cards = computed(() => buildCards(GA4_FIELDS, props.ga4Metrics))
const gscCards = computed(() => buildCards(GSC_FIELDS, props.gscMetrics))

/* GSC 双线 series (复用 SiteCardGsc 同款配色: 蓝 #4285f4 + 紫 #a142f4) */
const gscSparklineSeries = computed(() => [
  { points: props.gscSparklineClicks      || [], color: '#4285f4' },
  { points: props.gscSparklineImpressions || [], color: '#a142f4' },
])

/* ============================================================
   三点菜单 (仅单站点模式, 复用 SiteCard 同款逻辑)
   ============================================================ */
const menuRef = ref(null)
const menuOpen = ref(false)
const menuLayer = ref(false)

function onEdit()    { menuOpen.value = false; emit('edit',    props.project) }
function onInstall() { menuOpen.value = false; emit('install', props.project) }
function onDelete()  { menuOpen.value = false; emit('delete',  props.project) }

function onClickOutside(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) menuOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onClickOutside))
onUnmounted(() => document.removeEventListener('pointerdown', onClickOutside))

/* 详情链接: 仅单站点模式 */
const detailLink = computed(() =>
  isOverview.value ? null : localePath(`/projects/${props.project?.project_key}`),
)
</script>

<template>
  <!-- ============================================================
       外层卡片: sm:col-span-2 跨 2 格 = 单源卡 2 倍宽
       让每半区有充足空间显示完整指标名 (Visitors / Page Views / 等)
       配合父级 useCombo 模式网格 lg:grid-cols-4 让每行恰好 2 张 combo, 整齐.
       移动单列 (grid-cols-1) 时 col-span-2 等效全宽.
       ============================================================ -->
  <div
    :class="[
      'group rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40 sm:col-span-2',
      menuLayer ? 'overflow-visible' : 'overflow-hidden',
    ]"
  >
    <!-- ============ 共享 Header: favicon + 名字 + 右上角 (打开 + 三点菜单)
                       loading 时整行骨架 (favicon + 名字 pulse) ============ -->
    <div class="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <template v-if="loading">
          <div class="size-5 shrink-0 animate-pulse rounded bg-gray-100" />
          <div class="h-3.5 w-24 animate-pulse rounded bg-gray-100" />
        </template>
        <template v-else>
          <div class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100">
            <SiteFavicon :src="faviconUrl" :fallback-icon="fallbackIcon" />
          </div>
          <h3 class="truncate text-sm font-medium text-gray-900">{{ displayName }}</h3>
        </template>
      </div>

      <!-- 高度占位 (仅 loading + 单站点态): 跟真实卡右上 size-6 按钮组等高,
           防 header 从 24px → 20px 切换时整卡 4px 抖动 -->
      <div v-if="loading && !isOverview" class="size-6 shrink-0" aria-hidden="true" />

      <!-- 右上角操作 (仅单站点, loading 时整组隐藏不喧宾夺主) -->
      <div v-if="!isOverview && !loading" class="flex shrink-0 items-center gap-0.5">
        <NuxtLink
          v-if="detailLink"
          v-tooltip="t('projects.detail.open')"
          :to="detailLink"
          class="flex size-6 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-gray-100 hover:text-primary md:opacity-0 md:group-hover:opacity-100"
        >
          <NuxtIcon name="ri:fullscreen-line" class="size-4" />
        </NuxtLink>
        <div ref="menuRef" class="relative">
          <button
            type="button"
            class="flex size-6 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-gray-100 hover:text-gray-600 md:opacity-0 md:group-hover:opacity-100"
            @click="menuOpen = !menuOpen"
          >
            <NuxtIcon name="ri:more-2-fill" class="size-4" />
          </button>
          <Transition
            name="modal-fade"
            @before-enter="menuLayer = true"
            @after-leave="menuLayer = false"
          >
            <div
              v-if="menuOpen"
              class="absolute right-0 top-full z-10 mt-1 w-32 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
            >
              <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50" @click="onEdit">
                {{ t('common.edit') }}
              </button>
              <button v-if="showInstall" type="button" class="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50" @click="onInstall">
                {{ t('projects.install_code') }}
              </button>
              <button type="button" class="block w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-50" @click="onDelete">
                {{ t('common.delete') }}
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <!-- ============ 双半区: lg+ 左右 / sm- 上下
         lg:divide-x 让两半中间有竖线分隔; 移动端 divide-y 横线分隔
         双倍宽下恢复 px-4 padding, 内部呼吸 ============ -->
    <div class="grid grid-cols-1 divide-y divide-gray-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
      <!-- ===== GA4 半区 ===== -->
      <div class="px-4 pt-3 pb-2">
        <div class="grid grid-cols-3 gap-2">
          <div v-for="m in ga4Cards" :key="m.key" class="min-w-0 text-center">
            <div
              class="mb-0.5 truncate text-xs"
              :style="m.labelColor ? { color: m.labelColor } : { color: '#6b7280' }"
            >
              {{ m.label }}
            </div>
            <div class="text-base font-semibold tabular-nums leading-6">
              <div v-if="loading || numberLoading" class="mx-auto h-6 w-12 animate-pulse rounded bg-gray-200" />
              <span v-else-if="!m.has" class="text-gray-300">—</span>
              <span v-else class="text-gray-900">{{ m.display }}</span>
            </div>
          </div>
        </div>
        <div class="pt-1">
          <MiniSparkline :points="ga4Sparkline" :loading="loading || numberLoading" :height="28" />
        </div>
      </div>

      <!-- ===== GSC 半区 ===== -->
      <div class="px-4 pt-3 pb-2">
        <div class="grid grid-cols-3 gap-2">
          <div v-for="m in gscCards" :key="m.key" class="min-w-0 text-center">
            <div
              class="mb-0.5 truncate text-xs"
              :style="m.labelColor ? { color: m.labelColor } : { color: '#6b7280' }"
            >
              {{ m.label }}
            </div>
            <div class="text-base font-semibold tabular-nums leading-6">
              <div v-if="loading || numberLoading" class="mx-auto h-6 w-12 animate-pulse rounded bg-gray-200" />
              <span v-else-if="!m.has" class="text-gray-300">—</span>
              <span v-else class="text-gray-900">{{ m.display }}</span>
            </div>
          </div>
        </div>
        <div class="pt-1">
          <MiniSparkline :series="gscSparklineSeries" :loading="loading || numberLoading" :height="28" />
        </div>
      </div>
    </div>
  </div>
</template>
