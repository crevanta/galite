<template>
  <!-- ============================================================
       Projects Index - 项目列表
       未登录: 引导登录
       空状态: EmptyState + CTA
       已有: 工具栏 (周期/排序/脱敏/刷新/创建) + 卡片网格
       ============================================================ -->
  <div class="px-6 py-6 lg:px-10">
    <!-- ============ Header (ga-lite 紧凑风: 标题 + Add 按钮分两侧, 工具栏单行) ============ -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-bold text-gray-900">{{ $t('projects.title') }}</h1>
        <button
          v-if="userStore.user"
          type="button"
          v-tooltip="$t('projects.public.open_profile_settings')"
          class="inline-flex size-8 items-center justify-center text-gray-500 transition-colors hover:text-gray-900"
          :aria-label="$t('projects.public.open_profile_settings')"
          @click="openPublicProfileSettings"
        >
          <svg class="size-6" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor">
            <path d="M646.43333336 653.73333332c-16.8 0-30.3 13.6-30.3 30.3l0.2 182-546.3 0.3-0.2-546.4h182.3c16.8 0 30.3-13.6 30.3-30.3S268.83333336 259.33333332 252.03333336 259.33333332H69.73333336c-33.3 0-60.4 27-60.4 60.4V866.33333332c0 33.3 27.1 60.4 60.4 60.4H616.33333336c33.4-0.1 60.4-27.1 60.4-60.4V684.03333332c0.1-16.7-13.5-30.3-30.3-30.3" />
            <path d="M616.63333336 259.33333332H464.43333336c-16.8 0-30.3 13.6-30.3 30.3s13.6 30.3 30.3 30.3l109-0.2-251.9 251.9c-11.8 11.9-11.8 31.1 0 42.9 11.9 11.8 31.1 11.8 42.9 0L616.33333336 362.63333332v109.3c0 16.8 13.6 30.3 30.3 30.3s30.3-13.6 30.3-30.3V319.73333332c0.1-33.4-26.9-60.4-60.3-60.4" />
          </svg>
        </button>
      </div>
      <button
        v-if="userStore.user"
        type="button"
        class="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-text hover:opacity-90"
        @click="openCreate"
      >
        <NuxtIcon name="ri:add-line" class="size-4" />
        {{ $t('projects.create') }}
      </button>
    </div>

    <!-- ============ 工具栏: 周期 / 脱敏 / 排序 / 刷新 ============ -->
    <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
      <PeriodSwitcher
        v-model="period"
        responsive
        allow-custom
        @request-custom="customModalVisible = true"
      />
      <div class="flex items-center gap-1.5">
        <button
          v-if="showSameSiteMergeButton"
          type="button"
          v-tooltip="$t('projects.merge.same_site_tip')"
          :disabled="sameSiteMergeBusy"
          class="hidden size-9 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-60 md:inline-flex"
          @click="openSameSiteMerge"
        >
          <NuxtIcon
            name="ri:git-merge-line"
            :class="['size-5', sameSiteMergeBusy ? 'animate-spin' : '']"
          />
        </button>
        <HideToggle v-model="hideNames" />
        <SortDropdown
          :model-value="sortBy"
          :options="sortOptions"
          @update:model-value="onSortPick"
        />
        <RefreshButton :loading="refreshing" @refresh="manualRefresh" />
      </div>
    </div>

    <p v-if="isLoggedIn && metricsUpdatedLabel" class="mt-3 text-xs text-gray-400" aria-live="polite">
      {{ $t('projects.metrics_updated_at', { time: metricsUpdatedLabel }) }}
      <span v-if="metricsUpdating"> · {{ $t('projects.metrics_updating') }}</span>
    </p>

    <!-- ============ 加载骨架: 列表 OR 指标尚未就绪
         两种触发场景:
         1. !fetched         首次进入页面, 列表都没拉 → 默认 8 张单源骨架
         2. list 已有项目但 metricsFetched=false
            场景: 跨页 (如 /realtime) 切回 /projects, useState 让 fetched=true
            preserved 但本组件 metricsMap 是新鲜空 ref, 此时还没拉指标
            → 沿用骨架避免短暂闪空态 ("No sites yet")
            → 用 list.providers 推断 combo/单源形态, 骨架长条/普通宽度
              跟最终形态对齐, 加载完成时网格不抖动 ============ -->
    <div
      v-if="isLoggedIn && (!fetched || (list.length > 0 && !metricsFetched))"
      :class="[
        'mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4',
        skeletonUseCombo ? 'lg:grid-cols-4' : 'lg:grid-cols-3',
      ]"
    >
      <!-- 总览骨架: unified 双区卡 (col-span-2 长条) -->
      <SiteCardUnified
        v-if="skeletonUseCombo"
        mode="overview"
        :overview-label="$t('overview.all_sites')"
        :site-metrics="null"
        :search-metrics="null"
        :loading="true"
      />
      <SiteCard
        v-else
        mode="overview"
        :overview-label="$t('overview.all_sites')"
        :metrics="null"
        :loading="true"
      />
      <!-- 项目骨架: 与最终布局同口径 ——
           双区 → 每项目一张长条占位;
           单栏 → 每项目按 providers 吐 GA4/Search 单宽占位 (数量与最终单栏一致);
           首屏 list 为空时退化到固定 7 张单源占位 -->
      <template v-if="list.length > 0">
        <template v-if="skeletonUseCombo">
          <SiteCardUnified
            v-for="p in list"
            :key="'skc-' + p.project_key"
            mode="site"
            :site-metrics="null"
            :search-metrics="null"
            :loading="true"
          />
        </template>
        <template v-else>
          <template v-for="p in list" :key="'sks-' + p.project_key">
            <SiteCard v-if="(p.providers || []).includes('ga4')" mode="site" :metrics="null" :loading="true" />
            <SiteCard v-if="(p.providers || []).some((x) => ['gsc', 'bing'].includes(x))" mode="site" :metrics="null" :loading="true" />
          </template>
        </template>
      </template>
      <template v-else>
        <SiteCard
          v-for="i in 7"
          :key="'skel-empty-' + i"
          mode="site"
          :metrics="null"
          :loading="true"
        />
      </template>
    </div>

    <!-- ============ 空态 (列表已拉完且确认 0 项目)
         判空真相源是 list (项目列表) 而非 totalCards (指标数据派生);
         旧代码看 totalCards 会在 "list 已有项目, 指标还没拉" 的窗口误判 0 ============ -->
    <EmptyState
      v-else-if="isLoggedIn && fetched && list.length === 0"
      :title="$t('projects.empty')"
      :description="$t('projects.empty_desc')"
      :cta-label="$t('projects.create')"
      @cta="openCreate"
    />

    <!-- ============ 统一卡片网格 (二态: useCombo / 单源)
         useCombo 仅在 GA4+Search 同站覆盖率 > 50% 时启用,
           全部走 SiteCardUnified (col-span-2 = 双倍宽),
           lg 也用 4 列让每行恰好 2 张 combo, 避免 3 列下 col-span-2 留单格空位.
         单源时正常 sm:2 / lg:3 / xl:4 列单源卡.
         仅在登录后渲染数据卡片 ============ -->
    <div
      v-else-if="isLoggedIn"
      :class="[
        'mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4',
        useCombo ? 'lg:grid-cols-4' : 'lg:grid-cols-3',
      ]"
    >
      <!-- ============ 总览卡 (按 overviewMode 三态)
           列表已 fetched, header (站点标签) 永远稳定, 用 number-loading
           只让指标 + sparkline pulse, 避免周期切换时整张卡闪烁 ============ -->
      <SiteCardUnified
        v-if="overviewMode === 'combo'"
        mode="overview"
        :overview-label="`${$t('overview.all_sites')} (${overviewCount})`"
        :site-metrics="totals"
        :site-sparkline="totalsSparkline"
        :search-metrics="searchTotals"
        :search-sparkline-clicks="searchTotalsSparkClicks"
        :search-sparkline-impressions="searchTotalsSparkImpressions"
        :search-provider-metrics="searchProviderTotals"
        :site-number-loading="isLoggedIn && metricsLoading"
        :search-number-loading="isLoggedIn && searchLoading"
      />
      <SiteCard
        v-else-if="overviewMode === 'ga4'"
        mode="overview"
        :overview-label="`${$t('overview.all_sites')} (${overviewCount})`"
        :metrics="totals"
        :sparkline="totalsSparkline"
        :number-loading="isLoggedIn && metricsLoading"
      />
      <SiteCardGsc
        v-else-if="overviewMode === 'gsc'"
        mode="overview"
        :overview-label="`${$t('overview.all_search')} (${overviewCount})`"
        :metrics="searchTotals"
        :sparkline-clicks="searchTotalsSparkClicks"
        :sparkline-impressions="searchTotalsSparkImpressions"
        :number-loading="searchLoading"
      />

      <!-- ============ useCombo: 全部项目走 SiteCardUnified
           show-install: project.providers 含 'ga4' 才显示「安装代码」入口
                         纯 Search 项目无需埋点, 隐藏更干净 ============ -->
      <template v-if="useCombo">
        <div
          v-for="(p, idx) in allList"
          :key="'combo-lock-' + p.project_key"
          :class="projectCardShellClass(true)"
        >
          <div>
            <SiteCardUnified
              mode="site"
              :project="p"
              :site-metrics="metricsMap[p.project_key] || null"
              :site-sparkline="sparklineMap[p.project_key] || []"
              :search-metrics="searchProjectMap[p.project_key]?.metrics || null"
              :search-sparkline-clicks="searchProjectMap[p.project_key]?.sparkline_clicks || []"
              :search-sparkline-impressions="searchProjectMap[p.project_key]?.sparkline_impressions || []"
              :search-provider-metrics="searchProjectMap[p.project_key]?.providers || {}"
              :site-number-loading="isLoggedIn && metricsLoading"
              :search-number-loading="isLoggedIn && searchLoading"
              :show-install="(p.providers || []).includes('ga4')"
              :hide-names="hideNames"
              :index="idx"
              @edit="openEdit"
              @public-settings="openPublicSettings"
              @install="openInstall"
              @delete="askDelete"
            />
          </div>
        </div>
      </template>

      <!-- ============ 单栏模式: 同站 GA4/Search 前后相邻 (singleCards 已交错排序) ============ -->
      <template v-else>
        <div
          v-for="(card, idx) in singleCards"
          :key="card.key"
          :class="projectCardShellClass(false)"
        >
          <div>
            <SiteCard
              v-if="card.type === 'ga4'"
              mode="site"
              :project="card.project"
              :metrics="metricsMap[card.project.project_key] || null"
              :sparkline="sparklineMap[card.project.project_key] || []"
              :number-loading="isLoggedIn && metricsLoading"
              :hide-names="hideNames"
              :index="idx"
              @edit="openEdit"
              @public-settings="openPublicSettings"
              @install="openInstall"
              @delete="askDelete"
            />
            <SiteCardGsc
              v-else
              mode="site"
              :project="card.project"
              :metrics="searchProjectMap[card.project.project_key]?.metrics || null"
              :sparkline-clicks="searchProjectMap[card.project.project_key]?.sparkline_clicks || []"
              :sparkline-impressions="searchProjectMap[card.project.project_key]?.sparkline_impressions || []"
              :number-loading="searchLoading"
              :hide-names="hideNames"
              :index="idx"
              @edit="openEdit"
              @public-settings="openPublicSettings"
              @delete="askDelete"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- ============ 创建/编辑弹窗 ============ -->
    <ProjectFormModal
      :visible="formVisible"
      :mode="formMode"
      :project="editingProject"
      @close="formVisible = false"
      @saved="onSaved"
    />

    <!-- ============ 公开设置弹窗 ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="publicSettingsVisible"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="closePublicSettings"
        >
          <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <div class="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gray-100">
                    <img
                      v-if="publicSettingsIconUrl"
                      :src="publicSettingsIconUrl"
                      class="size-full object-cover"
                      referrerpolicy="no-referrer"
                      alt=""
                    />
                    <NuxtIcon v-else name="ri:global-line" class="size-4 text-gray-400" />
                  </div>
                  <h3 class="min-w-0 truncate text-lg font-bold text-gray-900">{{ publicSettingsTitle }}</h3>
                </div>
                <NuxtLink
                  v-if="publicSettingsPreviewUrl"
                  :to="publicSettingsPreviewUrl"
                  target="_blank"
                  class="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
                >
                  <NuxtIcon name="ri:external-link-line" class="size-3.5 shrink-0" />
                  <span class="truncate">{{ $t('projects.public.preview') }}</span>
                </NuxtLink>
              </div>
              <button
                type="button"
                class="flex size-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                :aria-label="$t('common.close')"
                @click="closePublicSettings"
              >
                <NuxtIcon name="ri:close-line" class="size-5" />
              </button>
            </div>
            <ProjectPublicSettings
              class="mt-4"
              :project="publicSettingsProject"
              @loaded="onPublicSettingsLoaded"
              @saved="onPublicSettingsSaved"
            />
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ============ 公共主页未开启提示 ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="publicProfileRequiredVisible"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="publicProfileRequiredVisible = false"
        >
          <section class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div class="flex items-start justify-between gap-4">
              <div class="flex min-w-0 items-center gap-3">
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
                  <NuxtIcon name="ri:global-line" class="size-5" />
                </span>
                <h3 class="text-base font-bold text-gray-900">{{ $t('projects.public.profile_required_title') }}</h3>
              </div>
              <button
                type="button"
                class="flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                :aria-label="$t('common.close')"
                @click="publicProfileRequiredVisible = false"
              >
                <NuxtIcon name="ri:close-line" class="size-5" />
              </button>
            </div>
            <p class="mt-3 text-sm leading-6 text-gray-500">
              {{ $t('projects.public.profile_required_desc') }}
            </p>
            <div class="mt-6 flex justify-end gap-2">
              <button
                type="button"
                class="rounded-full px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                @click="publicProfileRequiredVisible = false"
              >
                {{ $t('common.cancel') }}
              </button>
              <button
                type="button"
                class="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-text hover:opacity-90"
                @click="openPublicProfileSettingsFromPrompt"
              >
                {{ $t('projects.public.profile_required_action') }}
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>

    <!-- ============ 安装代码弹窗 ============ -->
    <InstallCodeModal
      :visible="installVisible"
      :project="installingProject"
      @close="installVisible = false"
    />

    <!-- ============ 自定义日期选择: 写入统一 custom_START_END period，
         由既有 period watch 重拉全站聚合数据 ============ -->
    <CustomDateModal
      :visible="customModalVisible"
      :model-value="period"
      @close="customModalVisible = false"
      @apply="onApplyCustom"
    />

    <!-- ============ 同站点资源合并确认 (PC 工具栏入口)
         只合并 Search-only → 唯一 GA4 目标; 多 GA4 同域名跳过, 避免错并真实 property. ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="sameSiteMergeVisible"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="sameSiteMergeBusy ? null : (sameSiteMergeVisible = false)"
        >
          <div class="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <h3 class="text-lg font-bold text-gray-900">{{ $t('projects.merge.same_site_title') }}</h3>
            <p class="mt-2 text-sm leading-relaxed text-gray-500">
              {{ $t('projects.merge.same_site_desc') }}
            </p>

            <div class="mt-4 max-h-64 space-y-3 overflow-y-auto">
              <div
                v-for="item in sameSiteMergeSnapshot"
                :key="item.domain"
                class="rounded-xl border border-gray-100 bg-gray-50 p-3"
              >
                <div class="text-sm font-semibold text-gray-900">{{ item.domain }}</div>
                <div class="mt-1 text-xs text-gray-500">
                  {{ $t('projects.merge.same_site_target', { name: item.target.name }) }}
                </div>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <span
                    v-for="source in item.sources"
                    :key="source.project_key"
                    class="rounded-full bg-white px-2 py-1 text-xs text-gray-500 ring-1 ring-gray-200"
                  >
                    {{ source.name }}
                  </span>
                </div>
              </div>
            </div>

            <p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
              {{ $t('projects.merge.warning_irreversible') }}
            </p>

            <div class="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                class="rounded-full px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                :disabled="sameSiteMergeBusy"
                @click="sameSiteMergeVisible = false"
              >
                {{ $t('common.cancel') }}
              </button>
              <button
                type="button"
                class="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-text hover:opacity-90 disabled:opacity-50"
                :disabled="sameSiteMergeBusy"
                @click="confirmSameSiteMerge"
              >
                {{ sameSiteMergeBusy ? $t('projects.merge.merging') : $t('projects.merge.btn_merge_same_site') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ============ 删除确认 ============ -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div
          v-if="deletingProject"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[3px]"
          @click.self="deletingProject = null"
        >
          <div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 class="text-lg font-bold text-red-600">{{ $t('common.delete') }}</h3>
            <p class="mt-2 text-sm text-gray-500">
              {{ $t('projects.delete_confirm', { name: deletingProject.name }) }}
            </p>

            <!-- ============ GA4 联动删除: 仅当该项目挂了 GA4 才出现, 默认不勾 ============ -->
            <label
              v-if="deletingHasGa4"
              class="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl bg-gray-50 p-3"
            >
              <input
                v-model="deleteGa4Too"
                type="checkbox"
                class="mt-0.5 size-4 shrink-0 rounded border-gray-300 text-red-500 focus:ring-red-400"
              >
              <span class="text-sm text-gray-600">
                {{ $t('projects.delete_also_ga4') }}
                <span class="mt-1 block text-xs text-gray-400">{{ $t('projects.delete_also_ga4_hint') }}</span>
              </span>
            </label>

            <div class="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                class="rounded-full px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
                @click="deletingProject = null"
              >
                {{ $t('common.cancel') }}
              </button>
              <button
                type="button"
                class="rounded-full bg-red-500 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                :disabled="deleting"
                @click="confirmDelete"
              >
                {{ $t('common.delete') }}
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
   /projects - 项目列表页
   工具栏: 周期 / 排序 / 脱敏 / 手动刷新 / 创建
   数据流: fetchList -> 并发 fetchSummary(period) per project
   持久化: URL 优先 + localStorage 回退保存 period / sortBy / hideNames
   ============================================================ */

import { computed, nextTick, onMounted, ref, unref, watch } from 'vue'
import EmptyState from '~/components/layout/EmptyState.vue'
import HideToggle from '~/components/layout/HideToggle.vue'
import RefreshButton from '~/components/layout/RefreshButton.vue'
import SortDropdown from '~/components/layout/SortDropdown.vue'
import CustomDateModal from '~/components/metrics/CustomDateModal.vue'
import PeriodSwitcher from '~/components/metrics/PeriodSwitcher.vue'
import SiteCard from '~/components/projects/SiteCard.vue'
import SiteCardGsc from '~/components/projects/SiteCardGsc.vue'
import SiteCardUnified from '~/components/projects/SiteCardUnified.vue'
import ProjectFormModal from '~/components/projects/ProjectFormModal.vue'
import InstallCodeModal from '~/components/projects/InstallCodeModal.vue'
import ProjectPublicSettings from '~/components/public/ProjectPublicSettings.vue'
import { stripLocalePrefix } from '~/utils/locale-path'
import { buildCustomPeriod, parseCustomPeriod } from '~/utils/period'
import { resolveProjectIcon } from '~/utils/project-icon'
import { projectSnapshotCache, snapshotOwner } from '~/utils/project-snapshot'

const { t, locale, locales } = useI18n()
const localePath = useLocalePath()
const route = useRoute()
const router = useRouter()
const { isLoggedIn } = useAuth()
const userStore = useUserStore()
const api = useApi()
const openLogin = inject('openLogin', () => {})
const openAccount = inject('openAccount', () => {})

/* ---- 浏览器标签标题: "我的网站 · account@example.com - GA Lite" ---- */
const pageTitle = useAccountTitle(() => t('projects.title'))
useHead({ title: () => pageTitle.value })

const { list, loading, fetched, fetchList, merge, remove } = useProjects()
const { list: dataSourceList, fetchList: fetchDataSourceList } = useDataSources()
const { fetchOverview, fetchOverviewSearch } = useGlobalMetrics()
const { show: showToast } = useToast()

/* ============================================================
   SSR 预拉 list (setup 顶层 await, 仅 server 阶段执行)
   --
   目的: 让 HTML 渲染时 list.providers 就位, 骨架屏首屏即可按真实
        combo/单源形态渲染, 首次访问跟跨页切回拥有同等精准度.
   --
   - useApi 已自动透传浏览器 cookie 给 nitro (useApi.js#L41), 服务端
     middleware 02.auth.js 可解析出登录态, 无需手动 fetch 头.
   - 失败静默: SSR 拉不到就回退到"未 fetched 默认 8 张单源骨架",
     不阻塞页面渲染, 让 client onMounted 再补拉.
   - useState 让 SSR 拉到的 list / fetched 自动水合到 client,
     client setup 不重复执行 (import.meta.server=false 守卫).
   ============================================================ */
if (import.meta.server && isLoggedIn.value && !fetched.value) {
  await fetchList().catch(() => {})
}

/* ---- localStorage keys ---- */
const LS_PERIOD = 'galite:projects:period'
const LS_SORT = 'galite:projects:sort'
const LS_SORT_USER = 'galite:projects:sort_user_v2'
const LS_HIDE = 'galite:projects:hide_names'

/* ---- 项目列表支持默认 5 个周期 + custom_START_END；URL 是可分享视图的真相源 ---- */
const DEFAULT_PERIOD = '28days'
const VALID_PERIODS = ['today', 'yesterday', '7days', '28days', '90days']

function isAllowedPeriod(value) {
  return VALID_PERIODS.includes(value) || parseCustomPeriod(value) != null
}

function periodFromRoute() {
  const value = String(route.query.period || '').trim()
  return isAllowedPeriod(value) ? value : ''
}

/* ---- 工具栏状态 ---- */
const period = ref(periodFromRoute() || DEFAULT_PERIOD)
const sortBy = ref('views')
const sortPinned = ref(false)
const pinnedSort = ref('')
const hideNames = ref(false)
const refreshing = ref(false)
const customModalVisible = ref(false)
let periodHydrated = false

function onApplyCustom({ start, end }) {
  period.value = buildCustomPeriod(start, end)
}

function projectCardShellClass(wide = false) {
  return [
    'relative min-w-0',
    wide ? 'sm:col-span-2' : '',
  ]
}
/* ---- metrics: project_key -> { totalUsers, screenPageViews, averageSessionDuration, activeUsers } ---- */
const metricsMap = ref({})
const totals = ref(null)
const metricsLoading = ref(false)
/* ---- metricsFetched: 标记 fetchAllMetrics 至少跑完一次 (无论成败)
        作用: 跨页 (/realtime 等) 切回时, useProjects.fetched 因 useState 保留为 true,
              但本组件 metricsMap 是新鲜空 ref, 若仅看 fetched 会立刻跳到 v-else 走主网格,
              此时 ga4List/searchList 都空 → totalCards=0 → 误闪 "No sites yet" 空态.
              用 metricsFetched 把骨架屏延续到指标真正拉完为止 ---- */
const metricsFetched = ref(false)

/* ---- sparkline: project_key -> number[] (PV 时序点);
        跨项目总览 sparkline 单独存 totalsSparkline ---- */
const sparklineMap = ref({})
const totalsSparkline = ref([])

/* ===========================================================
   Search 区: 与 GA4 平行的一组数据 (GSC + Bing)
     searchProjects:           [{project_key,name,site_url,metrics,sparkline_clicks,sparkline_impressions,providers}]
     searchTotals:             { clicks, impressions, ctr, position }
     searchTotalsSparkline*:   跨项目累加的双线
   按 period 同 GA4 一起重拉, 失败静默 (没 Search 项目时整组不渲染)
   =========================================================== */
const searchProjects = ref([])
const searchTotals = ref(null)
const searchProviderTotals = ref({})
const searchTotalsSparkClicks = ref([])
const searchTotalsSparkImpressions = ref([])
const searchLoading = ref(false)

/* ===========================================================
   同站点资源合并入口显示条件
   - PC 端: 由模板 hidden md:inline-flex 控制
   - 授权态: 必须同时存在有效 GA4 + Search 授权
   =========================================================== */
const hasGa4Integration = computed(() =>
  dataSourceList.value.some((a) => a.provider === 'ga4' && Number(a.status) === 1),
)
const hasSearchIntegration = computed(() =>
  dataSourceList.value.some((a) => ['gsc', 'bing'].includes(a.provider) && Number(a.status) === 1),
)
const showSameSiteMergeButton = computed(() =>
  isLoggedIn.value &&
  hasGa4Integration.value &&
  hasSearchIntegration.value &&
  sameSiteMergeCandidates.value.length > 0,
)

/* ===========================================================
   同站点候选扫描
   --
   只处理一个确定性场景: 同域名下有唯一 GA4 目标 + 一个或多个 Search-only
   源项目. 多个 GA4 同域名跳过, 因为 GA4 property_id 才是真身份,
   自动按域名乱并会把真实数据源揉坏.
   =========================================================== */
function normalizeDomain(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  if (s.startsWith('sc-domain:')) return s.slice('sc-domain:'.length).replace(/^www\./, '')
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return url.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hasProvider(project, provider) {
  const arr = Array.isArray(project?.providers) ? project.providers : []
  return arr.includes(provider)
}
function hasSearchProvider(project) {
  const arr = Array.isArray(project?.providers) ? project.providers : []
  return arr.some((p) => ['gsc', 'bing'].includes(p))
}

const sameSiteMergeCandidates = computed(() => {
  if (!isLoggedIn.value) return []
  const groups = new Map()
  for (const p of list.value) {
    if (!hasProvider(p, 'ga4') && !hasSearchProvider(p)) continue
    const domain = normalizeDomain(p.site_url)
    if (!domain) continue
    const bucket = groups.get(domain) || []
    bucket.push(p)
    groups.set(domain, bucket)
  }

  const out = []
  for (const [domain, projects] of groups) {
    const ga4Targets = projects.filter((p) => hasProvider(p, 'ga4'))
    const gscOnlySources = projects.filter((p) => hasSearchProvider(p) && !hasProvider(p, 'ga4'))
    if (ga4Targets.length !== 1 || gscOnlySources.length === 0) continue
    out.push({
      domain,
      target: ga4Targets[0],
      sources: gscOnlySources.filter((p) => p.project_key !== ga4Targets[0].project_key),
    })
  }
  return out.filter((item) => item.sources.length > 0)
})

/* ===========================================================
   Search 项目快速索引 (含 metrics + 双线 sparkline)
   =========================================================== */
const searchProjectMap = computed(() => {
  const map = {}
  for (const p of searchProjects.value) map[p.project_key] = p
  return map
})

/* ===========================================================
   卡片布局策略
   --
   双区卡只适合同站同时挂 GA4 + Search 的项目占多数时使用.
   Bing 纳入 Search provider group 后, 这里仍按同一个项目是否同时拥有
   ga4 与任一搜索源(gsc/bing)计算覆盖率; 未超过 50% 默认单源卡,
   避免纯 GA4 / 纯 Search 站点被大量空半区稀释.
   =========================================================== */
const ga4SourcedCount = computed(() =>
  list.value.filter((p) => hasProvider(p, 'ga4')).length,
)
const searchSourcedCount = computed(() =>
  list.value.filter((p) => hasSearchProvider(p)).length,
)

const dataSourcedCount = computed(() =>
  list.value.filter((p) => hasProvider(p, 'ga4') || hasSearchProvider(p)).length,
)
const comboEligibleCount = computed(() =>
  list.value.filter((p) => hasProvider(p, 'ga4') && hasSearchProvider(p)).length,
)
const comboMajority = computed(() =>
  dataSourcedCount.value > 0 && comboEligibleCount.value * 2 > dataSourcedCount.value,
)

const useCombo = computed(() => comboMajority.value)

const skeletonUseCombo = computed(() => useCombo.value)

/* ---- 总览模式: 双区跟随覆盖率; 单源展示主体数据源, 同数优先 GA4 ---- */
const overviewMode = computed(() => {
  if (useCombo.value) return 'combo'
  return searchSourcedCount.value > ga4SourcedCount.value ? 'gsc' : 'ga4'
})

/* ---- 项目元信息快速索引 ---- */
const projectByKey = computed(() => {
  const map = {}
  for (const p of list.value) map[p.project_key] = p
  return map
})

/* ---- 全部项目 key 集合 (combo 模式下每张卡 = 一个 key) ---- */
const allProjectKeys = computed(() => {
  const set = new Set()
  for (const p of list.value) {
    if (hasProvider(p, 'ga4') || hasSearchProvider(p)) set.add(p.project_key)
  }
  for (const k of Object.keys(metricsMap.value)) set.add(k)
  for (const p of searchProjects.value) set.add(p.project_key)
  return Array.from(set)
})

/* ===========================================================
   排序选项 — provider-aware: 跟着数据源走
     created 恒在;
     有 GA4 站 → views / users / session (GA4 指标);
     有 Search 站 → clicks / impressions / position (Search 指标).
   两组之间插 divider, 让(最多)7 项不糊成一片.
   =========================================================== */
const showGa4Sorts = computed(() =>
  !fetched.value || ga4SourcedCount.value > 0,
)
const showSearchSorts = computed(() => searchSourcedCount.value > 0)

const sortOptions = computed(() => {
  const opts = [{ value: 'created', label: t('projects.toolbar.sort_created') }]
  if (showGa4Sorts.value) {
    opts.push(
      { divider: true },
      { value: 'views',    label: t('projects.toolbar.sort_views') },
      { value: 'users',    label: t('projects.toolbar.sort_users') },
      { value: 'duration', label: t('projects.toolbar.sort_duration') },
    )
  }
  if (showSearchSorts.value) {
    opts.push(
      { divider: true },
      { value: 'clicks',      label: t('projects.toolbar.sort_clicks') },
      { value: 'impressions', label: t('projects.toolbar.sort_impressions') },
      { value: 'position',    label: t('projects.toolbar.sort_position') },
    )
  }
  return opts
})

function hasSortOption(v) {
  return sortOptions.value.some((o) => o.value === v)
}

function defaultSortValue() {
  if (hasSortOption('views')) return 'views'
  if (hasSortOption('clicks')) return 'clicks'
  return 'created'
}

function resolveSortValue(v) {
  if (hasSortOption(v)) return v
  return defaultSortValue()
}

function applySortForOptions() {
  const wanted = sortPinned.value ? pinnedSort.value : defaultSortValue()
  const next = resolveSortValue(wanted)
  if (sortBy.value !== next) sortBy.value = next
}

/* 排序默认值跟着数据源走:
   GA4 → 浏览量; Search-only → 点击次数; 无可排序指标 → 创建时间.
   旧版 created 持久值没有用户意图标记, 按旧默认处理. */
function restoreSort(stored, userPinned) {
  sortPinned.value = Boolean(stored && (userPinned || stored !== 'created'))
  pinnedSort.value = sortPinned.value ? stored : ''
  applySortForOptions()
}

function onSortPick(v) {
  sortPinned.value = true
  pinnedSort.value = v
  sortBy.value = resolveSortValue(v)
  if (typeof window !== 'undefined') {
    localStorage.setItem(LS_SORT, v)
    localStorage.setItem(LS_SORT_USER, '1')
  }
}

/* 当前数据源下不可用的存档排序 (如 Search-only 用户存了 views) 要临时降级,
   否则 SortDropdown 触发按钮 label 会变空白. */
watch(sortOptions, applySortForOptions, { immediate: true })

/* ============================================================
   一次 overview 请求拿全部: 各项目 metrics + 跨站 totals
   ============================================================ */

let metricsRequestId = 0
let metricsPollTimer
const metricsUpdating = ref(false)
const gaCachedAt = ref(0)
const searchCachedAt = ref(0)
const metricsUpdatedLabel = computed(() => {
  const times = [gaCachedAt.value, searchCachedAt.value].filter(Boolean)
  return times.length ? new Date(Math.min(...times) * 1000).toLocaleString(locale.value) : ''
})
onUnmounted(() => { metricsRequestId++; clearTimeout(metricsPollTimer) })

function applyGaOverview(data) {
  const next = {}, sparkNext = {}
  for (const item of (data?.projects || [])) {
    next[item.project_key] = item.metrics || null
    sparkNext[item.project_key] = Array.isArray(item.sparkline) ? item.sparkline : []
  }
  metricsMap.value = next
  sparklineMap.value = sparkNext
  totals.value = data?.totals || null
  totalsSparkline.value = Array.isArray(data?.sparkline) ? data.sparkline : []
  gaCachedAt.value = data?.cached_at || 0
}

function applySearchOverview(data) {
  searchProjects.value = data?.projects || []
  searchTotals.value = data?.totals || null
  searchProviderTotals.value = data?.provider_totals || {}
  searchTotalsSparkClicks.value = Array.isArray(data?.sparkline_clicks) ? data.sparkline_clicks : []
  searchTotalsSparkImpressions.value = Array.isArray(data?.sparkline_impressions) ? data.sparkline_impressions : []
  searchCachedAt.value = data?.cached_at || 0
}

watch(isLoggedIn, loggedIn => {
  if (!loggedIn) {
    metricsRequestId++
    clearTimeout(metricsPollTimer)
    applyGaOverview(null)
    applySearchOverview(null)
    metricsFetched.value = false
    metricsUpdating.value = false
  }
})

async function fetchAllMetrics({ refresh = false, background = false, poll = 0, restore = false } = {}) {
  const requestId = ++metricsRequestId
  const requestedPeriod = period.value
  const owner = isLoggedIn.value ? snapshotOwner(userStore.user) : ''
  if (!owner) return
  const snapshots = projectSnapshotCache()
  const revision = snapshots.revision()
  const current = () => requestId === metricsRequestId && isLoggedIn.value
    && snapshotOwner(userStore.user) === owner
    && period.value === requestedPeriod && snapshots.revision() === revision
  clearTimeout(metricsPollTimer)
  const saved = restore ? snapshots.read(owner, requestedPeriod) : null
  if (!background) {
    applyGaOverview(saved?.ga4)
    applySearchOverview(saved?.search)
    metricsLoading.value = !saved?.ga4
    searchLoading.value = !saved?.search
    metricsFetched.value = Boolean(saved)
  }
  // Restoring a snapshot is synchronous; revalidation never hides its cards.
  metricsUpdating.value = true
  let updating = false
  await Promise.all([
    fetchOverview(requestedPeriod, { refresh }).catch(() => null).then(resGa => {
      if (!current()) return
      if (resGa?.code === 200) {
        if (!resGa.data?.partial || !gaCachedAt.value) applyGaOverview(resGa.data)
        snapshots.write(owner, requestedPeriod, 'ga4', resGa.data, revision)
      } else if (!background && !saved?.ga4) {
        if (resGa) showToast(resGa?.msg || t('metrics.failed'), { type: 'error' })
        applyGaOverview(null)
      }
      updating ||= Boolean(resGa?.data?.refreshing)
      metricsLoading.value = false
      metricsFetched.value = true
    }),
    fetchOverviewSearch(requestedPeriod, { refresh }).catch(() => null).then(resSearch => {
      if (!current()) return
      if (resSearch?.code === 200) {
        if (!resSearch.data?.partial || !searchCachedAt.value) applySearchOverview(resSearch.data)
        snapshots.write(owner, requestedPeriod, 'search', resSearch.data, revision)
      } else if (!background && !saved?.search) {
        applySearchOverview(null)
      }
      updating ||= Boolean(resSearch?.data?.refreshing)
      searchLoading.value = false
      metricsFetched.value = true
    }),
  ])
  if (!current()) {
    // A successful mutation invalidates both storage and in-flight UI responses.
    if (requestId === metricsRequestId && isLoggedIn.value
      && snapshotOwner(userStore.user) === owner && period.value === requestedPeriod) {
      await fetchAllMetrics({ refresh: true })
    }
    return
  }
  metricsUpdating.value = updating
  if (updating && poll < 12) {
    metricsPollTimer = setTimeout(() => fetchAllMetrics({ background: true, poll: poll + 1 }), 5000)
  }
}

/* ===========================================================
   两态卡片列表
   - useCombo:   allList = 全部项目 key (统一 SiteCardUnified, 缺数据半区留空)
   - 单源模式:    ga4List / searchList 各自走原 SiteCard / SiteCardGsc
   sortBy 仅对 GA4 metrics 字段有意义 → useCombo 时按 GA4 metrics 排序,
   单源 Search 模式按 created 顺序 (Search 无对应排序键)
   =========================================================== */
function pickProject(k) {
  return projectByKey.value[k] || searchProjectMap.value[k] || null
}

/* ===========================================================
   统一排序 — 按 sortBy 选指标源 + 方向
     GA4 (views/users/duration): 读 metricsMap, 越大越前 (降序)
     Search clicks/impressions:  读 searchProjectMap, 越大越前 (降序)
     Search position:            越小越前 (升序); 无曝光/无数据沉底
   缺该指标的项目一律沉底, 不参与"假排序".
   =========================================================== */
const GA4_SORT_FIELD = { views: 'screenPageViews', users: 'totalUsers', duration: 'averageSessionDuration' }

function sortProjects(items) {
  const key = sortBy.value
  if (key === 'created') return items

  /* GA4 指标: 降序, 缺失沉底 */
  const ga4Field = GA4_SORT_FIELD[key]
  if (ga4Field) {
    const pick = (k) => {
      const m = metricsMap.value[k]
      return m ? Number(m[ga4Field]) || 0 : -Infinity
    }
    return [...items].sort((a, b) => pick(b.project_key) - pick(a.project_key))
  }

  /* Search clicks / impressions: 降序, 缺失沉底 */
  if (key === 'clicks' || key === 'impressions') {
    const pick = (k) => {
      const m = searchProjectMap.value[k]?.metrics
      return m ? Number(m[key]) || 0 : -Infinity
    }
    return [...items].sort((a, b) => pick(b.project_key) - pick(a.project_key))
  }

  /* Search position: 升序 (越小越靠前); 无曝光(0)/无数据 视为无效沉底 */
  if (key === 'position') {
    const pick = (k) => {
      const m = searchProjectMap.value[k]?.metrics
      const imp = m ? Number(m.impressions) || 0 : 0
      return imp > 0 ? (Number(m.position) || Infinity) : Infinity
    }
    return [...items].sort((a, b) => pick(a.project_key) - pick(b.project_key))
  }

  return items
}

/* ---- useCombo: 全部项目 + 按当前 sortBy 排序 (缺该指标的项目排底) ---- */
const allList = computed(() =>
  sortProjects(allProjectKeys.value.map(pickProject).filter(Boolean)),
)

/* ---- GA4 项目集合 (membership + 计数用; 实际渲染顺序由 allList/singleCards 决定) ---- */
const ga4List = computed(() =>
  list.value.filter((p) => hasProvider(p, 'ga4')),
)

/* ---- 单 Search 模式: Search overview 已按创建顺序返 ----
   pickProject 入参是 project_key (与 ga4List/allList 同约定), searchProjects 是
   对象数组 → 必须显式取 .project_key 喂进去. 直接 .map(pickProject) 会把整个
   对象当 key 查 projectByKey["[object Object]"]=undefined → 全 null → 列表清空.
   这个隐患仅在 Search-only 形态 (用户取消 GA4 授权) 暴露, combo 模式走 allList 不触发. */
const searchList = computed(() =>
  list.value.filter((p) => hasSearchProvider(p)),
)

/* ===========================================================
   单栏卡片序列: 全局按当前 sortBy 排序, 同站点 GA4 卡在前、Search 卡紧随其后
   --
   去重并集 (ga4List ∪ searchList) → sortProjects 统一排序 (GA4/Search 指标都支持) →
   每个项目按自身拥有的源吐出对应卡, 让"同一站点的两张卡"自然挨在一起.
   复用 ga4List / searchList 已解析好的项目对象, 不重复 pickProject.
   =========================================================== */
const singleCards = computed(() => {
  const ga4Keys = new Set(ga4List.value.map((p) => p.project_key))
  const searchKeys = new Set(searchList.value.map((p) => p.project_key))
  const byKey = new Map()
  for (const p of ga4List.value) byKey.set(p.project_key, p)
  for (const p of searchList.value) if (!byKey.has(p.project_key)) byKey.set(p.project_key, p)
  const ordered = sortProjects([...byKey.values()])
  const out = []
  for (const p of ordered) {
    if (ga4Keys.has(p.project_key)) out.push({ type: 'ga4', key: `ga4-${p.project_key}`, project: p })
    if (searchKeys.has(p.project_key)) out.push({ type: 'gsc', key: `search-${p.project_key}`, project: p })
  }
  return out
})

/* ---- 总览卡站点计数: 跟随总览主体 (combo=全站; 单栏=主体源站点数) ---- */
const overviewCount = computed(() => {
  if (useCombo.value) return allList.value.length
  if (overviewMode.value === 'gsc') return searchList.value.length
  return ga4List.value.length
})

/* ============================================================
   表单 / 删除
   ============================================================ */

const formVisible = ref(false)
const formMode = ref('create')
const editingProject = ref(null)

const publicSettingsVisible = ref(false)
const publicSettingsProject = ref(null)
const publicSettingsPreviewPath = ref('')
const publicSettingsPreviewUrl = computed(() => localizePublicPreviewPath(publicSettingsPreviewPath.value))
const publicProfileRequiredVisible = ref(false)
const publicProfileChecking = ref(false)
const publicSettingsTitle = computed(() =>
  publicSettingsProject.value?.name || t('projects.unnamed'),
)
const publicSettingsIconUrl = computed(() => resolveProjectIcon(publicSettingsProject.value))

function localizePublicPreviewPath(value) {
  const activeLocale = locale.value
  const raw = String(value || '').trim()
  if (!raw) return ''

  if (/^[a-z][a-z\d+\-.]*:/i.test(raw)) {
    if (!import.meta.client) return raw
    try {
      const url = new URL(raw)
      if (url.origin !== window.location.origin) return raw
      return localePath(stripLocalePrefix(`${url.pathname}${url.search}${url.hash}`, unref(locales)), activeLocale)
    } catch {
      return raw
    }
  }

  const path = raw.startsWith('/') ? raw : `/${raw}`
  return localePath(stripLocalePrefix(path, unref(locales)), activeLocale)
}

const installVisible = ref(false)
const installingProject = ref(null)

const deletingProject = ref(null)
const deleting = ref(false)
/* 删除时是否顺带删 GA4 远端 property — 默认不勾; 仅项目挂了 GA4 才显示该选项 */
const deleteGa4Too = ref(false)
const deletingHasGa4 = computed(() => {
  const pk = deletingProject.value?.project_key
  if (!pk) return false
  const providers = projectByKey.value[pk]?.providers || deletingProject.value?.providers || []
  return providers.includes('ga4')
})

const sameSiteMergeVisible = ref(false)
const sameSiteMergeBusy = ref(false)
const sameSiteMergeSnapshot = ref([])

function openCreate() {
  formMode.value = 'create'
  editingProject.value = null
  formVisible.value = true
}

function openEdit(p) {
  formMode.value = 'edit'
  editingProject.value = p
  formVisible.value = true
}

async function publicProfileEnabled() {
  if (publicProfileChecking.value) return null
  publicProfileChecking.value = true
  try {
    const res = await api.get('/api/profile/settings')
    if (res?.code !== 200) {
      showToast(res?.msg || t('account.public_profile.load_failed'), { type: 'error' })
      return false
    }
    return Number(res.data?.profile?.status) === 1
  } catch (err) {
    showToast(err?.message || t('account.public_profile.load_failed'), { type: 'error' })
    return false
  } finally {
    publicProfileChecking.value = false
  }
}

function openPublicProfileSettings() {
  if (!isLoggedIn.value) {
    openLogin()
    return
  }
  openAccount('public')
}

function openPublicProfileSettingsFromPrompt() {
  publicProfileRequiredVisible.value = false
  closePublicSettings()
  openPublicProfileSettings()
}

async function openPublicSettings(p) {
  if (!isLoggedIn.value) {
    openLogin()
    return
  }
  const enabled = await publicProfileEnabled()
  if (enabled === null) return
  if (!enabled) {
    publicProfileRequiredVisible.value = true
    return
  }
  publicSettingsProject.value = p
  publicSettingsPreviewPath.value = ''
  publicSettingsVisible.value = true
}

function closePublicSettings() {
  publicSettingsVisible.value = false
  publicSettingsProject.value = null
  publicSettingsPreviewPath.value = ''
}

function onPublicSettingsLoaded(setting) {
  publicSettingsPreviewPath.value = setting?.public_url || ''
}

function patchPublicProjectSetting(setting) {
  if (!setting?.project_key) return
  list.value = list.value.map((item) =>
    item.project_key === setting.project_key
      ? { ...item, ...setting }
      : item,
  )
  if (publicSettingsProject.value?.project_key === setting.project_key) {
    publicSettingsProject.value = {
      ...publicSettingsProject.value,
      ...setting,
    }
  }
}

function onPublicSettingsSaved(setting) {
  patchPublicProjectSetting(setting)
  if (setting?.public_url) publicSettingsPreviewPath.value = setting.public_url
}

function openInstall(p) {
  installingProject.value = p
  installVisible.value = true
}

function askDelete(p) {
  deletingProject.value = p
  deleteGa4Too.value = false   /* 每次打开重置, 默认不勾 */
}

async function confirmDelete() {
  if (!deletingProject.value || deleting.value) return
  deleting.value = true
  try {
    const res = await remove(deletingProject.value.project_key, { alsoDeleteGa4: deleteGa4Too.value })
    if (res?.code === 200) {
      /* GA4 联动删除失败时本地仍已删: 给个非阻断 info 提示, 引导手动处理 */
      const ga4 = res.data?.ga4
      const ga4Failed = ga4 && ga4.failed > 0
      showToast(
        ga4Failed ? t('projects.delete_ga4_failed') : t('projects.delete_success'),
        { type: ga4Failed ? 'info' : 'success' },
      )
      deletingProject.value = null
    } else {
      showToast(res?.msg || t('projects.delete_failed'), { type: 'error' })
    }
  } catch (err) {
    showToast(err?.message || t('projects.delete_failed'), { type: 'error' })
  } finally {
    deleting.value = false
  }
}

async function onSaved() {
  await fetchAllMetrics()
}

/* ============================================================
   同站点资源合并: Search-only 项目 -> 唯一 GA4 目标项目
   ============================================================ */

function openSameSiteMerge() {
  if (sameSiteMergeBusy.value) return
  const candidates = sameSiteMergeCandidates.value
  if (!candidates.length) {
    showToast(t('projects.merge.no_same_site'), { type: 'info' })
    return
  }
  sameSiteMergeSnapshot.value = candidates.map((item) => ({
    domain: item.domain,
    target: item.target,
    sources: [...item.sources],
  }))
  sameSiteMergeVisible.value = true
}

async function confirmSameSiteMerge() {
  if (sameSiteMergeBusy.value) return
  sameSiteMergeBusy.value = true
  let merged = 0
  let failed = 0

  try {
    for (const item of sameSiteMergeSnapshot.value) {
      for (const source of item.sources) {
        try {
          const res = await merge(source.project_key, item.target.project_key, { refresh: false })
          if (res?.code === 200) merged++
          else failed++
        } catch {
          failed++
        }
      }
    }

    await Promise.all([
      fetchList().catch(() => null),
      fetchAllMetrics().catch(() => null),
    ])
  } finally {
    sameSiteMergeBusy.value = false
  }

  if (merged > 0) {
    showToast(t('projects.merge.bulk_success', { count: merged }), { type: failed ? 'warning' : 'success' })
    sameSiteMergeVisible.value = false
    sameSiteMergeSnapshot.value = []
  }
  if (failed > 0) {
    showToast(t('projects.merge.bulk_failed', { count: failed }), { type: merged ? 'warning' : 'error' })
  }
}

/* ============================================================
   手动刷新 + 周期切换 -> 重拉指标
   ============================================================ */

async function manualRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.all([
      fetchList(),
      fetchDataSourceList().catch(() => null),
      fetchAllMetrics({ refresh: true, background: true }),
    ])
  } finally {
    refreshing.value = false
  }
}

/* period 双向同步: 切换后 URL 可直接分享；URL 前进/后退由下方 watcher 反写状态。 */
watch(period, async (v) => {
  if (typeof window !== 'undefined') localStorage.setItem(LS_PERIOD, v)
  if (String(route.query.period || '') !== v) {
    router.replace({ query: { ...route.query, period: v } })
  }
  if (!periodHydrated) return
  await fetchAllMetrics({ restore: true })
})

watch(() => route.query.period, (v) => {
  const value = String(v || '').trim()
  if (!value || value === period.value) return
  if (isAllowedPeriod(value)) period.value = value
})

watch(hideNames, (v) => {
  if (typeof window !== 'undefined') localStorage.setItem(LS_HIDE, v ? '1' : '0')
})

/* ============================================================
   挂载: 读 localStorage + 拉数据
   ============================================================ */

onMounted(async () => {
  let storedSort = ''
  let storedSortPinned = false
  if (typeof window !== 'undefined') {
    const storedPeriod = localStorage.getItem(LS_PERIOD)
    /* 外部链接指定日期必须压过本地偏好；无参数时才恢复上次手动选择。 */
    if (!periodFromRoute() && storedPeriod && isAllowedPeriod(storedPeriod)) {
      period.value = storedPeriod
    }
    localStorage.setItem(LS_PERIOD, period.value)
    storedSort = localStorage.getItem(LS_SORT) || ''
    storedSortPinned = localStorage.getItem(LS_SORT_USER) === '1'
    hideNames.value = localStorage.getItem(LS_HIDE) === '1'
  }
  /* 让 localStorage 恢复触发的 watcher 完成 URL 同步，但不重复请求聚合数据。 */
  await nextTick()
  periodHydrated = true
  if (!isLoggedIn.value) {
    restoreSort(storedSort, storedSortPinned)
    return
  }
  const revalidation = Promise.all([
    fetched.value ? Promise.resolve() : fetchList(),
    fetchDataSourceList().catch(() => null),
    fetchAllMetrics({ restore: true }),
  ])
  restoreSort(storedSort, storedSortPinned)
  await revalidation
})
</script>
