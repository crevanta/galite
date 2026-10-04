<script setup>
/* ============================================================
   SiteCardGsc - 我的网站 (GSC 数据源卡)
   --
   设计意图 (与 SiteCard 对称):
   - 单一组件双模式:
       mode='site'     -> 单站点卡: favicon + 名字
       mode='overview' -> All Search 总览卡: 通用图标 + 标签
   - 3 指标 (clicks / impressions / position) — 与 GSC 后台一致
   - 双线 sparkline (clicks 蓝 + impressions 紫) — 与 GSC 后台同款配色
   - 单站点模式保留编辑入口, 纯 Search 项目也能配置公开状态
   --
   props.metrics:  { clicks, impressions, ctr, position } | null
   props.sparklineClicks:      number[]  时序点
   props.sparklineImpressions: number[]  时序点
   ============================================================ */

import { computed, ref } from 'vue'
import MiniSparkline from '~/components/projects/MiniSparkline.vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'
import ProjectCardMenu from './ProjectCardMenu.vue'

const props = defineProps({
  project:       { type: Object,  default: null },
  overviewLabel: { type: String,  default: '' },
  metrics:       { type: Object,  default: null },
  sparklineClicks:      { type: Array, default: () => [] },
  sparklineImpressions: { type: Array, default: () => [] },
  /* loading: 完整骨架 (favicon + 名字 + 指标 + sparkline 全 pulse), 用于首次加载占位 */
  loading:        { type: Boolean, default: false },
  /* numberLoading: 仅指标 + sparkline pulse, 用于周期切换/刷新 (header 保持稳定不闪) */
  numberLoading:  { type: Boolean, default: false },
  hideNames: { type: Boolean, default: false },
  index:     { type: Number,  default: 0 },
  mode:      { type: String,  default: 'site' },
})

const emit = defineEmits(['edit', 'public-settings', 'delete'])
const localePath = useLocalePath()
const { t } = useI18n()

const isOverview = computed(() => props.mode === 'overview')

/* ---- 显示名字: 总览 / 脱敏 / 真实 ---- */
const displayName = computed(() => {
  if (isOverview.value) return props.overviewLabel || t('overview.all_search')
  if (props.hideNames) return `Site #${props.index + 1}`
  return props.project?.name || t('projects.unnamed') || '—'
})

/* ---- 站点图标: 用户配置优先，否则使用本地通用图标 ---- */
const faviconUrl = computed(() => {
  if (isOverview.value || props.hideNames) return ''
  return resolveProjectIcon(props.project)
})

/* ---- 无 favicon 时的兜底图标 ---- */
const fallbackIcon = computed(() => {
  if (isOverview.value) return 'ri:search-line'   /* 总览: 搜索 */
  if (props.hideNames)  return 'ri:eye-off-line'  /* 脱敏: 隐藏眼 */
  return 'ri:global-line'
})

/* ============================================================
   3 列指标 (clicks / impressions / position)
   - clicks/impressions: 整数(K/M 简写)
   - position: 浮点保留 1 位 (排名 3.7 比 3 精准)
   ============================================================ */
/* labelColor: 指标名颜色与下方对应折线颜色一致, 让用户秒匹配"哪条线是哪指标" */
const FIELDS = [
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
function formatDecimal(v) {
  const n = Number(v) || 0
  if (n === 0) return '—'
  return n.toFixed(1)
}
function format(value, kind) {
  return kind === 'decimal' ? formatDecimal(value) : formatInt(value)
}

const cards = computed(() =>
  FIELDS.map((f) => ({
    key: f.key,
    label: t(f.label),
    labelColor: f.labelColor || '',
    has: props.metrics != null && props.metrics[f.key] !== undefined,
    display: props.metrics != null && props.metrics[f.key] !== undefined
      ? format(props.metrics[f.key], f.format)
      : '—',
  })),
)

/* ---- 双线 series 给 MiniSparkline (GSC 后台同款配色)
        clicks      = #4285f4 Google blue
        impressions = #a142f4 purple ---- */
const sparklineSeries = computed(() => [
  { points: props.sparklineClicks      || [], color: '#4285f4' },
  { points: props.sparklineImpressions || [], color: '#a142f4' },
])

/* ---- 菜单淡出期间保持卡片 overflow-visible，避免弹层被圆角裁切 ---- */
const menuLayer = ref(false)

function onEdit() {
  emit('edit', props.project)
}

function onPublicSettings() {
  emit('public-settings', props.project)
}

function onDelete() {
  emit('delete', props.project)
}

/* ---- 详情链接: 仅单站点模式; 整体卡片不可点 ---- */
const detailLink = computed(() =>
  isOverview.value ? null : localePath(`/projects/${props.project?.project_key}`),
)
</script>

<template>
  <!-- ============ 外层卡片 (与 SiteCard 视觉对齐) ============ -->
  <div
    :class="[
      'group rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40',
      menuLayer ? 'overflow-visible' : 'overflow-hidden',
    ]"
  >
    <!-- ============ Header: favicon + 名字 + GSC logo + 打开 (loading 时整行骨架) ============ -->
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

      <!-- 高度占位 (仅 loading 态): 跟真实卡右上 size-6 打开按钮等高,
           防 header 从 24px → 20px 切换时整卡 4px 抖动 -->
      <div v-if="loading" class="size-6 shrink-0" aria-hidden="true" />

      <!-- 右侧: 打开详情 + 编辑菜单 (loading 时隐藏不喧宾夺主) -->
      <div v-if="!isOverview && !loading" class="flex shrink-0 items-center gap-0.5">
        <NuxtLink
          v-if="detailLink"
          v-tooltip="t('projects.detail.open')"
          :to="detailLink"
          class="flex size-6 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-gray-100 hover:text-primary md:opacity-0 md:group-hover:opacity-100"
        >
          <NuxtIcon name="ri:fullscreen-line" class="size-4" />
        </NuxtLink>
        <ProjectCardMenu
          :source-links="project?.source_links || []"
          :site-url="project?.site_url || ''"
          :hide-resource-labels="hideNames"
          show-delete
          @layer-change="menuLayer = $event"
          @edit="onEdit"
          @public-settings="onPublicSettings"
          @delete="onDelete"
        />
      </div>
    </div>

    <!-- ============ 3 列指标 (label 颜色匹配下方双线) ============ -->
    <div class="grid grid-cols-3 gap-2 px-4 pt-3">
      <div v-for="m in cards" :key="m.key" class="min-w-0 text-center">
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

    <!-- ============ 双线 sparkline (clicks 蓝 + impressions 紫) ============ -->
    <div class="px-3 pb-2 pt-1">
      <MiniSparkline :series="sparklineSeries" :loading="loading || numberLoading" :height="28" />
    </div>
  </div>
</template>
