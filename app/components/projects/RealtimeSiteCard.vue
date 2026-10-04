<script setup>
/* ============================================================
   RealtimeSiteCard - 实时在线站点卡 (含总览卡同款样式)
   --
   设计意图:
   - 单一组件双模式:
       mode='site'     -> 单站点: favicon + 名字 + 大数字 active users
       mode='overview' -> 累计总览: 通用图标 + "All sites" + 聚合大数字
   - 跟 SiteCard 同样紧凑 header + 单大数字内容区
   - 加载: 灰色骨架; 失败: 红色 "—"; 脱敏: Site #N + 数字圈
   --
   props.activeUsers: number | null (null 表示拉取失败)
   ============================================================ */

import { computed } from 'vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'

const props = defineProps({
  project:        { type: Object, default: null },
  overviewLabel:  { type: String, default: '' },
  activeUsers:    { type: [Number, null], default: 0 },
  /* loading: 完整骨架 (favicon + 名字 + 数字 全 pulse), 用于首次加载 */
  loading:        { type: Boolean, default: false },
  /* numberLoading: 仅数字 pulse, 用于切换周期/刷新 (header 保持稳定不闪) */
  numberLoading:  { type: Boolean, default: false },
  hideNames:      { type: Boolean, default: false },
  index:          { type: Number, default: 0 },
  mode:           { type: String, default: 'site' },
})

const localePath = useLocalePath()
const { t } = useI18n()

const isOverview = computed(() => props.mode === 'overview')

const displayName = computed(() => {
  if (isOverview.value) return props.overviewLabel || t('overview.all_sites')
  if (props.hideNames) return `Site #${props.index + 1}`
  return props.project?.name || '—'
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

const display = computed(() => {
  if (props.activeUsers == null) return '—'
  return Number(props.activeUsers || 0).toLocaleString()
})

const detailLink = computed(() =>
  isOverview.value ? null : localePath(`/projects/${props.project?.project_key}`),
)
</script>

<template>
  <div class="group overflow-hidden rounded-xl border border-gray-200 bg-white transition-colors hover:border-primary/40">
    <!-- ============ Header: favicon + 名字 + 右上角外链 (loading 时整行骨架) ============ -->
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
      <!-- 高度占位 (仅 loading + 单站点态): 跟真实卡 size-6 按钮等高,
           防 header 从 24px → 20px 切换时整卡 4px 抖动 -->
      <div v-if="loading && !isOverview" class="size-6 shrink-0" aria-hidden="true" />

      <NuxtLink
        v-if="!loading && detailLink"
        v-tooltip="t('projects.detail.open')"
        :to="detailLink"
        class="flex size-6 shrink-0 items-center justify-center rounded text-gray-400 transition-opacity hover:bg-gray-100 hover:text-primary md:opacity-0 md:group-hover:opacity-100"
      >
        <NuxtIcon name="ri:fullscreen-line" class="size-4" />
      </NuxtLink>
    </div>

    <!-- ============ 单大数字 (骨架高度 = text-3xl 行高 36px = h-9) ============ -->
    <div class="px-4 py-5 text-center">
      <div class="text-3xl font-bold tabular-nums leading-9">
        <div v-if="loading || numberLoading" class="mx-auto h-9 w-20 animate-pulse rounded bg-gray-200" />
        <span v-else-if="activeUsers == null" class="text-red-400">—</span>
        <span v-else class="text-gray-900">{{ display }}</span>
      </div>
    </div>
  </div>
</template>
