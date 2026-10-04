<script setup>
/* ============================================================
   SiteSwitcherModal - 站点切换器
   --
   场景: 详情页 header 中"切换"图标按钮触发, 在保持当前筛选条件下
         跳到其它站点的详情页 (period 由 localStorage 自动延续, 这里
         只负责选目标项目)
   --
   props.visible:    显示开关
   props.currentKey: 当前所在站点 project_key (高亮 + 不可点击自身)
   props.projects:   完整项目列表 (调用方注入, 模态不主动拉取)
   emit('close'):    关闭
   emit('select', project): 选中某个站点 (调用方负责跳转)
   --
   交互细节:
     - 顶部搜索框 autofocus
     - 列表 3 列网格: favicon+名字 / URL / enter 图标
     - 搜索本地过滤 name + site_url, 大小写不敏感
     - 弹窗关闭时自动清空搜索词
     - ESC 关闭 (与项目其它弹窗一致)
   ============================================================ */

import { computed, ref, watch } from 'vue'
import SiteFavicon from './SiteFavicon.vue'
import { resolveProjectIcon } from '~/utils/project-icon'

const props = defineProps({
  visible:         { type: Boolean,  required: true },
  currentKey:      { type: String,   default: '' },
  projects:        { type: Array,    default: () => [] },
})

const emit = defineEmits(['close', 'select'])

const { t } = useI18n()
const search = ref('')

/* visible 关闭时复位搜索, 下一次打开是干净状态 */
watch(() => props.visible, (v) => {
  if (!v) search.value = ''
})

/* ESC 关闭 (mount 期监听 document, unmount 取消) */
function onKeydown(e) {
  if (props.visible && e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

/* 本地过滤: name 或 site_url 命中关键词 (case-insensitive) */
const filtered = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return props.projects
  return props.projects.filter((p) => {
    const name = String(p.name || '').toLowerCase()
    const url  = String(p.site_url || '').toLowerCase()
    return name.includes(kw) || url.includes(kw)
  })
})

function faviconOf(p) {
  return resolveProjectIcon(p)
}

function onSelect(p) {
  if (p.project_key === props.currentKey) return
  emit('select', p)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-start justify-center bg-black/20 p-4 pt-[10vh] backdrop-blur-[3px]"
        @click.self="$emit('close')"
      >
        <div class="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
          <!-- ============ 搜索框 ============ -->
          <div class="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
            <NuxtIcon name="ri:search-line" class="size-5 shrink-0 text-gray-400" />
            <input
              v-model="search"
              type="text"
              :placeholder="t('projects.detail.switch_search')"
              class="flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
              autofocus
            />
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              :aria-label="t('common.close')"
              @click="$emit('close')"
            >
              <NuxtIcon name="ri:close-line" class="size-5" />
            </button>
          </div>

          <!-- ============ 列表 (滚动条由 main.css 全局 thin-scrollbar 规则托管) ============ -->
          <div class="max-h-[60vh] overflow-y-auto">
            <template v-if="filtered.length">
              <button
                v-for="p in filtered"
                :key="p.project_key"
                type="button"
                :class="[
                  'group relative grid w-full grid-cols-2 items-center gap-3 overflow-hidden px-4 py-2.5 text-left transition-colors',
                  p.project_key === currentKey
                    ? 'cursor-default bg-primary/5'
                    : 'hover:bg-gray-50',
                ]"
                :disabled="p.project_key === currentKey"
                @click="onSelect(p)"
              >
                <!-- 列1: favicon + 名字 -->
                <div class="flex min-w-0 items-center gap-2">
                  <div class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100">
                    <SiteFavicon :src="faviconOf(p)" />
                  </div>
                  <span class="truncate text-sm font-medium text-gray-900">{{ p.name }}</span>
                </div>
                <!-- 列2: URL -->
                <span class="truncate text-xs text-gray-500">{{ p.site_url || '—' }}</span>
              </button>
            </template>
            <div
              v-else
              class="flex h-32 items-center justify-center text-sm text-gray-400"
            >
              {{ t('projects.detail.switch_empty') }}
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
