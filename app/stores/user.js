/* ===========================================================
   User Store - 用户状态管理
   职责: 单一真相源，管理固定管理员的登录态与画像
   模式: Pinia Composition API (setup store)
   =========================================================== */

import { defineStore } from 'pinia'
import { projectSnapshotCache, snapshotOwner } from '~/utils/project-snapshot'

export const useUserStore = defineStore('user', () => {

  /* ===========================================================
     State - 响应式数据
     =========================================================== */

  const user = ref(null)
  const isLoggedIn = ref(false)

  /* ===========================================================
     Getters - 派生计算
     =========================================================== */

  /* ---- 显示名称: 昵称 > 邮箱前缀 > 匿名 ---- */
  const displayName = computed(() => {
    if (!user.value) return ''
    if (user.value.nickname) return user.value.nickname
    if (user.value.email) return user.value.email.split('@')[0]
    return 'User'
  })

  /* ===========================================================
     Actions - 状态变更
     =========================================================== */

  /* ---- 写入用户数据 ---- */
  function setUser(data) {
    if (user.value && snapshotOwner(user.value) !== snapshotOwner(data)) projectSnapshotCache().clear()
    user.value = data
    isLoggedIn.value = true
  }

  /* ---- 清空用户态 ---- */
  function clearUser() {
    projectSnapshotCache().clear()
    user.value = null
    isLoggedIn.value = false
  }

  /* ---- 从 API 拉取用户信息 ---- */
  async function fetchUser() {
    try {
      const api = useApi()
      const res = await api.get('/api/user/info')
      /* API 返回 { success, data: { email, nickname, ... } } */
      if (res?.success && res?.data) {
        setUser(res.data)
      } else {
        clearUser()
      }
    } catch {
      clearUser()
    }
  }

  return {
    /* state */
    user,
    isLoggedIn,
    /* getters */
    displayName,
    /* actions */
    setUser,
    clearUser,
    fetchUser,
  }
})
