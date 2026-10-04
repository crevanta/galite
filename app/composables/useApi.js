/* ===========================================================
   useApi - API 请求封装
   职责: 统一 HTTP 通信层，自动附加 JWT，统一错误处理
   设计: cookie 存储 token (SSR 安全)，401 自动跳转登录
   核心: SSR 走 h3 内部 fetcher (useRequestFetch), CSR 走全局 $fetch.
         in-process 子请求自动继承父 event 的 cookies / cloudflare binding,
         不出 Worker, 根除 cloudflare-module preset 下 self-fetch 子请求偶发
         cookie 上下文丢失而 401 的根因, 也连带消除 401 误删 ct_token 链路.
   =========================================================== */

/* ---- API 错误类型: 统一错误表示
       silent=true 表示业务侧不应 toast (典型: 401 未登录, layout 自动弹
       LoginModal, 不需要额外提示) ---- */
import { projectSnapshotCache } from '~/utils/project-snapshot'

export class ApiError extends Error {
  constructor(statusCode, message, data, silent = false) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.data = data
    this.silent = silent
  }
}

export function useApi() {

  const { t } = useI18n()

  /* ---- 统一 fetcher: SSR=event.$fetch (h3 in-process), CSR=globalThis.$fetch
          SSR 子请求由 Nitro 自动继承父 event 的 cookies + cloudflare env,
          不再依赖手动 Cookie 头透传, 也不出 Worker 走 self-fetch.
          (useRequestFetch 内部: useRequestEvent()?.$fetch || globalThis.$fetch) ---- */
  const requestFetch = useRequestFetch()

  /* ===========================================================
     核心请求方法
     流程: 构建 headers → requestFetch 发送 → 错误拦截 → 类型返回
     =========================================================== */

  async function request(url, method, body) {

    try {
      const result = await requestFetch(url, {
        method,
        credentials: 'same-origin',
        body: body ?? undefined,
      })
      if (method === 'POST' && result?.code === 200
        && /^\/api\/(projects|data-sources)\//.test(url)) {
        projectSnapshotCache().clear()
      }
      return result
    } catch (err) {
      /* ---- 错误路由: 按状态码分流处理 ---- */
      const statusCode = err?.statusCode
        ?? err?.response?.status
        ?? 500

      /* ---- 消息提取: 5xx 永远屏蔽, 4xx 取业务语义 ---- */
      const message = statusCode >= 500
        ? t('common.service_unavailable')
        : (err?.data?.message || err?.data?.msg || t('common.request_failed'))

      /* ---- 401: 认证失效, 仅清 token, 不跳路径
             layout (app.vue) watch isLoggedIn 会自动弹 LoginModal,
             用户停在当前页，不会被踢回官网.
             silent=true 让业务侧 catch 直接跳过 toast (避免"未授权"提示) ---- */
      if (statusCode === 401) {
        /* ---- 只允许浏览器端清登录 cookie. 防御性守卫:
               即便 SSR 经 h3 内部 fetcher 后仍偶发 401, 服务端写 null
               会在页面响应里 Set-Cookie 删除 ct_token, 把刚登录的会话
               立刻抹掉, 切语言 / 整页跳后浏览器直接掉登录态. ---- */
        throw new ApiError(401, message, err?.data, true)
      }

      throw new ApiError(statusCode, message, err?.data)
    }
  }

  /* ===========================================================
     GET - 数据读取
     =========================================================== */

  function get(url) {
    return request(url, 'GET')
  }

  /* ===========================================================
     POST - 数据提交
     =========================================================== */

  function post(url, body) {
    return request(url, 'POST', body)
  }

  return { get, post }
}
