<script setup>
/* ============================================================
   SiteCard - 我的网站站点卡 (含总览卡同款样式)
   --
   设计意图:
   - 单一组件双模式:
       mode='site'     -> 单站点卡: favicon + 名字 + 三点菜单 (编辑/删除)
       mode='overview' -> 累计总览卡: 通用图标 + "All sites" + 无菜单
   - 紧凑 header (px-3 py-2) + 三列指标网格 (Visitors / Page views / Engagement time)
   - 加载: 灰色骨架 animate-pulse
   - 失败: 红色 "—"
   - 脱敏 (hideNames=true): 名字 -> "Site #N", favicon -> 数字圈
   --
   props.metrics: { totalUsers, screenPageViews, averageSessionDuration, bounceRate } | null
                  null 表示拉取失败 -> 显示 "—"; 全 0 也正常显示 0 (跟 ga-lite 一致)
   ============================================================ */

import { computed, ref } from 'vue'
import MiniSparkline from '~/components/projects/MiniSparkline.vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'
import ProjectCardMenu from './ProjectCardMenu.vue'

const props = defineProps({
  /* 单站点模式必填 */
  project:   { type: Object, default: null },
  /* 总览模式必填 (不依赖 project) */
  overviewLabel: { type: String, default: '' },
  /* 通用 */
  metrics:   { type: Object, default: null },
  /* sparkline: PV 时序点 (number[]), 由 fetchOverview 注入
     长度按 period 变化: 24 (hour) / 7 / 28 / 13 / 26 / 12 (按月) */
  sparkline: { type: Array,  default: () => [] },
  /* loading: 完整骨架 (favicon + 名字 + 指标 + sparkline 全 pulse), 用于首次加载占位 */
  loading:        { type: Boolean, default: false },
  /* numberLoading: 仅指标 + sparkline pulse, 用于周期切换/刷新 (header 保持稳定不闪) */
  numberLoading:  { type: Boolean, default: false },
  hideNames: { type: Boolean, default: false },
  index:     { type: Number, default: 0 },
  mode:      { type: String, default: 'site' },
})

const emit = defineEmits(['edit', 'public-settings', 'install', 'delete'])

const localePath = useLocalePath()
const { t } = useI18n()

const isOverview = computed(() => props.mode === 'overview')

/* ---- 显示名字: 总览 / 脱敏 / 真实 ---- */
const displayName = computed(() => {
  if (isOverview.value) return props.overviewLabel || t('overview.all_sites')
  if (props.hideNames) return `Site #${props.index + 1}`
  return props.project?.name || t('projects.unnamed') || '—'
})

/* ---- 站点图标: 用户配置优先，否则使用本地通用图标 ---- */
const faviconUrl = computed(() => {
  if (isOverview.value || props.hideNames) return ''
  return resolveProjectIcon(props.project)
})

/* ---- 无 favicon 时显示通用图标 (脱敏 / 总览 / site_url 缺失统一走这里) ---- */
const fallbackIcon = computed(() => {
  if (isOverview.value) return 'ri:stack-line'      /* 总览: 堆叠 */
  if (props.hideNames)  return 'ri:eye-off-line'    /* 脱敏: 隐藏眼 */
  return 'ri:global-line'                           /* 缺 url: 地球 */
})

/* ============================================================
   3 列指标 (对齐 ga-lite: Visitors / Page views / Engagement time)
   ============================================================ */
/* labelColor: 指标名颜色与下方 sparkline 一致 — sparkline 用 PV 主题色,
   所以 page_views 标签也用主题色, 让用户一眼对上"线代表哪个指标" */
const FIELDS = [
  { key: 'totalUsers',             label: 'metrics.card.visitors',   format: 'int' },
  { key: 'screenPageViews',        label: 'metrics.card.page_views', format: 'int',     labelColor: 'var(--color-primary)' },
  { key: 'averageSessionDuration', label: 'metrics.card.engagement', format: 'duration' },
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
function format(value, kind) {
  return kind === 'duration' ? formatDuration(value) : formatInt(value)
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

/* ---- 菜单淡出期间保持卡片 overflow-visible，避免弹层被圆角裁切 ---- */
const menuLayer = ref(false)

function onEdit() { emit('edit', props.project) }
function onPublicSettings() { emit('public-settings', props.project) }
function onInstall() { emit('install', props.project) }
function onDelete() { emit('delete', props.project) }

/* ---- 详情链接: 仅单站点模式有, 由"打开"图标按钮触发, 整体卡片不可点 ---- */
const detailLink = computed(() =>
  isOverview.value ? null : localePath(`/projects/${props.project?.project_key}`),
)
</script>

<template>
  <!-- ============================================================
       外层卡片
       - 默认 overflow-hidden 让内部 border-b 与 rounded-xl 圆角对齐
       - 菜单期间 (含 fade-out) 切到 overflow-visible, 让 dropdown 完整伸出
       ============================================================ -->
  <div
    :class="[
      'group rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40',
      menuLayer ? 'overflow-visible' : 'overflow-hidden',
    ]"
  >
    <!-- ============ Header: favicon + 名字 + 右上角操作组 (loading 时整行骨架) ============ -->
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

      <!-- 单站点: 外链 + 三点菜单 (hover 显示, loading 时整组隐藏不喧宾夺主) -->
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
          show-install
          show-delete
          @layer-change="menuLayer = $event"
          @edit="onEdit"
          @public-settings="onPublicSettings"
          @install="onInstall"
          @delete="onDelete"
        />
      </div>
    </div>

    <!-- ============ 3 列指标 (label 颜色匹配 sparkline 单线) ============ -->
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

    <!-- ============ Sparkline (PV 趋势, 跟随顶部 period 变 granularity)
         紧贴指标下方, 同 px-4 让左右对齐; pb-3 让下边距与上方 pt-3 对称 ============ -->
    <div class="px-3 pb-2 pt-1">
      <MiniSparkline :points="sparkline" :loading="loading || numberLoading" :height="28" />
    </div>
  </div>
</template>
