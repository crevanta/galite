<script setup>
/* ============================================================
   SiteCardUnified - Site Data + Search Data 双区卡
   ============================================================ */

import { computed, ref } from 'vue'
import MiniSparkline from '~/components/projects/MiniSparkline.vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'
import ProjectCardMenu from './ProjectCardMenu.vue'

const props = defineProps({
  mode:          { type: String,  default: 'site' },
  project:       { type: Object,  default: null },
  overviewLabel: { type: String,  default: '' },

  siteMetrics:    { type: Object, default: null },
  siteSparkline:  { type: Array,  default: () => [] },

  searchMetrics:              { type: Object, default: null },
  searchSparklineClicks:      { type: Array,  default: () => [] },
  searchSparklineImpressions: { type: Array,  default: () => [] },
  searchProviderMetrics:      { type: Object, default: () => ({}) },

  loading:       { type: Boolean, default: false },
  numberLoading: { type: Boolean, default: false },
  showInstall:   { type: Boolean, default: true },
  hideNames:     { type: Boolean, default: false },
  index:         { type: Number,  default: 0 },
})

const emit = defineEmits(['edit', 'public-settings', 'install', 'delete'])
const localePath = useLocalePath()
const { t } = useI18n()

const isOverview = computed(() => props.mode === 'overview')

const displayName = computed(() => {
  if (isOverview.value) return props.overviewLabel || t('overview.all_sites')
  if (props.hideNames) return `Site #${props.index + 1}`
  return props.project?.name || t('projects.unnamed') || '-'
})

const faviconUrl = computed(() => {
  if (isOverview.value || props.hideNames) return ''
  return resolveProjectIcon(props.project)
})

const fallbackIcon = computed(() => {
  if (isOverview.value) return 'ri:stack-line'
  if (props.hideNames) return 'ri:eye-off-line'
  return 'ri:global-line'
})

const SITE_FIELDS = [
  { key: 'totalUsers',             label: 'metrics.card.visitors',   format: 'int' },
  { key: 'screenPageViews',        label: 'metrics.card.page_views', format: 'int',     labelColor: 'var(--color-primary)' },
  { key: 'averageSessionDuration', label: 'metrics.card.engagement', format: 'duration' },
]
const SEARCH_FIELDS = [
  { key: 'clicks',      label: 'metrics.card.clicks',      format: 'int',     labelColor: '#4285f4' },
  { key: 'impressions', label: 'metrics.card.impressions', format: 'int',     labelColor: '#a142f4' },
  { key: 'position',    label: 'metrics.card.position',    format: 'decimal' },
]

const PROVIDERS = [
  { id: 'gsc',  label: 'Google Search Console', icon: '/images/icon/google-search-console.svg' },
  { id: 'bing', label: 'Bing Webmaster',        icon: '/images/icon/bing-webmaster.svg' },
]

function formatInt(v) {
  const n = Number(v) || 0
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
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
  return n > 0 ? n.toFixed(1) : '-'
}
function format(value, kind) {
  if (kind === 'duration') return formatDuration(value)
  if (kind === 'decimal') return formatDecimal(value)
  return formatInt(value)
}

function buildCards(fields, metricsObj) {
  return fields.map((f) => ({
    key: f.key,
    label: t(f.label),
    labelColor: f.labelColor || '',
    has: metricsObj != null && metricsObj[f.key] !== undefined,
    display: metricsObj != null && metricsObj[f.key] !== undefined ? format(metricsObj[f.key], f.format) : '-',
  }))
}

const siteCards = computed(() => buildCards(SITE_FIELDS, props.siteMetrics))
const searchCards = computed(() => buildCards(SEARCH_FIELDS, props.searchMetrics))

const searchSparklineSeries = computed(() => [
  { points: props.searchSparklineClicks || [], color: '#4285f4' },
  { points: props.searchSparklineImpressions || [], color: '#a142f4' },
])

const providerBadges = computed(() => PROVIDERS
  .map((p) => {
    const metrics = props.searchProviderMetrics?.[p.id] || null
    if (!metrics) return null
    const clicks = formatInt(metrics.clicks)
    const impressions = formatInt(metrics.impressions)
    const tip = `${p.label}\n${t('metrics.card.clicks')}: ${clicks}\n${t('metrics.card.impressions')}: ${impressions}`
    return { ...p, clicks, tip }
  })
  .filter(Boolean))

const visibleProviderBadges = computed(() =>
  providerBadges.value.length > 1 ? providerBadges.value : [],
)

function providerMetricDisplay(provider, metricKey) {
  const metrics = props.searchProviderMetrics?.[provider] || {}
  const field = SEARCH_FIELDS.find((f) => f.key === metricKey)
  return format(metrics[metricKey], field?.format || 'int')
}

function providerMetricTooltip(metricKey) {
  if (visibleProviderBadges.value.length <= 1) return ''
  return {
    rows: visibleProviderBadges.value.map((p) => ({
      icon: p.icon,
      alt: p.label,
      value: providerMetricDisplay(p.id, metricKey),
    })),
  }
}

/* ---- 菜单淡出期间保持卡片 overflow-visible，避免弹层被圆角裁切 ---- */
const menuLayer = ref(false)

function onEdit() { emit('edit', props.project) }
function onPublicSettings() { emit('public-settings', props.project) }
function onInstall() { emit('install', props.project) }
function onDelete() { emit('delete', props.project) }

const detailLink = computed(() => isOverview.value ? null : localePath(`/projects/${props.project?.project_key}`))
</script>

<template>
  <div
    :class="[
      'group rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40 sm:col-span-2',
      menuLayer ? 'overflow-visible' : 'overflow-hidden',
    ]"
  >
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
          <div class="flex min-w-0 flex-1 items-center">
            <h3 class="min-w-0 truncate text-sm font-medium leading-5 text-gray-900">{{ displayName }}</h3>
            <div v-if="visibleProviderBadges.length" class="ml-3 flex shrink-0 items-center gap-1">
              <span
                v-for="p in visibleProviderBadges"
                :key="p.id"
                v-tooltip="p.tip"
                class="inline-flex h-4 items-center gap-1 rounded bg-gray-50 px-1.5 text-[11px] font-medium leading-none text-gray-500 ring-1 ring-gray-100"
              >
                <img :src="p.icon" class="size-3 rounded-sm object-contain" alt="" />
                <span class="tabular-nums">{{ p.clicks }}</span>
              </span>
            </div>
          </div>
        </template>
      </div>

      <div v-if="loading && !isOverview" class="size-6 shrink-0" aria-hidden="true" />

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
          :show-install="showInstall"
          show-delete
          @layer-change="menuLayer = $event"
          @edit="onEdit"
          @public-settings="onPublicSettings"
          @install="onInstall"
          @delete="onDelete"
        />
      </div>
    </div>

    <div class="grid grid-cols-1 divide-y divide-gray-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
      <div class="px-4 pt-3 pb-2">
        <div class="grid grid-cols-3 gap-2">
          <div v-for="m in siteCards" :key="m.key" class="min-w-0 text-center">
            <div class="mb-0.5 truncate text-xs" :style="m.labelColor ? { color: m.labelColor } : { color: '#6b7280' }">{{ m.label }}</div>
            <div class="text-base font-semibold tabular-nums leading-6">
              <div v-if="loading || numberLoading" class="mx-auto h-6 w-12 animate-pulse rounded bg-gray-200" />
              <span v-else-if="!m.has" class="text-gray-300">-</span>
              <span v-else class="text-gray-900">{{ m.display }}</span>
            </div>
          </div>
        </div>
        <div class="pt-1">
          <MiniSparkline :points="siteSparkline" :loading="loading || numberLoading" :height="28" />
        </div>
      </div>

      <div class="px-4 pt-3 pb-2">
        <div class="grid grid-cols-3 gap-2">
          <div v-for="m in searchCards" :key="m.key" class="min-w-0 text-center">
            <div class="mb-0.5 truncate text-xs" :style="m.labelColor ? { color: m.labelColor } : { color: '#6b7280' }">{{ m.label }}</div>
            <div class="text-base font-semibold tabular-nums leading-6">
              <div v-if="loading || numberLoading" class="mx-auto h-6 w-12 animate-pulse rounded bg-gray-200" />
              <span v-else-if="!m.has" class="text-gray-300">-</span>
              <span v-else class="text-gray-900" v-tooltip="providerMetricTooltip(m.key)">{{ m.display }}</span>
            </div>
          </div>
        </div>
        <div class="pt-1">
          <MiniSparkline :series="searchSparklineSeries" :loading="loading || numberLoading" :height="28" />
        </div>
      </div>
    </div>
  </div>
</template>
