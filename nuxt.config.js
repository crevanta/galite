// ===========================================================
// GA Lite - Nuxt 3 SSR 配置
// 多数据源站点洞察平台 (GA4/GSC/Bing)
// 部署目标: Cloudflare Workers + D1
// ===========================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

function stripJsonComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function readWranglerVars() {
  try {
    const configPath = resolve(process.cwd(), 'wrangler.jsonc')
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(stripJsonComments(raw))
    return parsed?.vars || {}
  } catch {
    return {}
  }
}

function includeServerAutoImport(file) {
  const normalized = String(file).replaceAll('\\', '/')
  return !normalized.includes('/utils/providers/') || normalized.endsWith('/utils/providers/index.js')
}

const wranglerVars = readWranglerVars()
const runtimeAppSecret = process.env.APP_SECRET || ''
const runtimeAppEnv = process.env.APP_ENV || wranglerVars.APP_ENV || 'dev'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  future: { compatibilityVersion: 3 },

  /* ---- 固定产品入口: 设置卡与官网页脚共享 ---- */
  appConfig: {
    productLinks: {
      repository: 'https://github.com/crevanta/galite',
      hosted: 'https://galite.io/',
    },
  },

  /* ---- 目录规范 ---- */
  srcDir: 'app/',
  serverDir: 'server/',
  dir: { public: '../public' },

  /* ---- SSR + Nitro ----
     注意: 不配 nitro.errorHandler — Nuxt 3 默认 errorHandler 负责渲染 app/error.vue
     (友好的 HTML 错误页). 若 override 等于砸掉 error.vue 渲染链.
     SQL/堆栈防泄露走 server/plugins/clean-api-errors.js 的 `error` hook 做
     in-place sanitize, 不干扰渲染. */
  ssr: true,
  nitro: {
    preset: 'cloudflare-module',
    // Keep discovery handlers outside dot-directories so deployment packaging
    // cannot silently omit them. Explicit handlers also fail the build if missing.
    handlers: [
      {
        route: '/.well-known/oauth-protected-resource',
        method: 'get',
        handler: resolve(process.cwd(), 'server/handlers/mcp/oauth-protected-resource.get.js'),
      },
      {
        route: '/.well-known/oauth-authorization-server',
        method: 'get',
        handler: resolve(process.cwd(), 'server/handlers/mcp/oauth-authorization-server.get.js'),
      },
    ],
    esbuild: { options: { target: 'es2022' } },
    alias: { 'safer-buffer': 'node:buffer' },
    /* Provider 适配器共享统一接口名，只显式注册，不扫描成全局 auto-import。 */
    imports: { dirsScanOptions: { fileFilter: includeServerAutoImport } },
    /* ---- 每五分钟清理超过 24 小时的聚合指标缓存与短期限流桶 ---- */
    experimental: { tasks: true },
    scheduledTasks: {
      '*/5 * * * *': ['clean-metrics-cache'],
    },
  },

  /* ---- Vite + HMR 稳定性 ---- */
  vite: {
    plugins: [tailwindcss()],
    clearScreen: false,
    server: {
      watch: {
        usePolling: true,
        interval: 100,
        binaryInterval: 300,
        ignored: [
          '**/.nuxt/**',
          '**/.output/**',
          '**/.wrangler/**',
          '**/dist/**',
          '**/node_modules/**',
          '**/migrations/**',
          '**/.git/**',
        ],
      },
    },
  },

  /* ---- 模块 ---- */
  modules: [
    '@pinia/nuxt',
    '@nuxtjs/i18n',
    '@nuxt/icon',
  ],

  /* ---- 图标 ---- */
  icon: {
    componentName: 'NuxtIcon',
    mode: 'svg',
    serverBundle: { collections: ['ri'] },
    clientBundle: { scan: true },
    fallbackToApi: false,
  },

  /* ---- Tailwind ---- */
  css: ['~/assets/css/main.css'],

  /* ---- 多语言：开源快照内置 25 种 locale ---- */
  i18n: {
    /* ---- locales 必须与 i18n/locales/*.json 一一对齐, 否则后台 supported_langs
            配置即便包含某语言, 前端切语言弹窗也不会展示 (getSupportedLocales 取交集).
            产品内置 25 语种列表, RTL 三个 (ar/fa/ur) 标 dir:'rtl'. ---- */
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'zh-cn', name: '简体中文', file: 'zh-cn.json' },
      { code: 'zh-tw', name: '繁體中文', file: 'zh-tw.json' },
      { code: 'ja', name: '日本語', file: 'ja.json' },
      { code: 'ko', name: '한국어', file: 'ko.json' },
      { code: 'es', name: 'Español', file: 'es.json' },
      { code: 'fr', name: 'Français', file: 'fr.json' },
      { code: 'de', name: 'Deutsch', file: 'de.json' },
      { code: 'pt-pt', name: 'Português', file: 'pt-pt.json' },
      { code: 'ru', name: 'Русский', file: 'ru.json' },
      { code: 'ar', name: 'العربية', file: 'ar.json', dir: 'rtl' },
      { code: 'hi', name: 'हिन्दी', file: 'hi.json' },
      { code: 'tr', name: 'Türkçe', file: 'tr.json' },
      { code: 'vi', name: 'Tiếng Việt', file: 'vi.json' },
      { code: 'th', name: 'ไทย', file: 'th.json' },
      { code: 'id', name: 'Indonesia', file: 'id.json' },
      { code: 'bn', name: 'বাংলা', file: 'bn.json' },
      { code: 'fa', name: 'فارسی', file: 'fa.json', dir: 'rtl' },
      { code: 'ur', name: 'اردو', file: 'ur.json', dir: 'rtl' },
      { code: 'pl', name: 'Polski', file: 'pl.json' },
      { code: 'nl', name: 'Nederlands', file: 'nl.json' },
      { code: 'uk', name: 'Українська', file: 'uk.json' },
      { code: 'it', name: 'Italiano', file: 'it.json' },
      { code: 'cs', name: 'Čeština', file: 'cs.json' },
      { code: 'uz', name: 'Oʻzbekcha', file: 'uz.json' },
    ],
    defaultLocale: process.env.DEFAULT_LOCALE || wranglerVars.DEFAULT_LOCALE || 'en',
    lazy: false,
    langDir: '../i18n/locales',
    strategy: 'prefix_except_default',
    detectBrowserLanguage: false,
    bundle: { optimizeTranslationDirective: false },
  },

  app: {
    head: {
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
    },
  },

  runtimeConfig: {
    appSecret: runtimeAppSecret,
    appEnv: runtimeAppEnv,
    public: {},
  },

  devServer: { port: 8787 },
  devtools: { enabled: false },

  hooks: {
    'pages:extend'(pages) {
      for (let i = pages.length - 1; i >= 0; i--) {
        if (['/public/profile', '/public/project'].includes(pages[i]?.path)) pages.splice(i, 1)
      }
      pages.push({
        name: 'public-profile',
        path: '/@:slug',
        file: resolve(process.cwd(), 'app/pages/public/profile.vue'),
      })
      pages.push({
        name: 'public-project',
        path: '/@:slug/:publicProjectKey',
        file: resolve(process.cwd(), 'app/pages/public/project.vue'),
      })
    },
  },
})
