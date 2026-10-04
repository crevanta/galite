/* ===================================================================
 * GA Lite OSS — Cloudflare D1 schema
 *
 * 单实例只有固定 owner。project_id / union_id 作为数据作用域兼容字段保留，
 * 值由服务端常量产生，外部请求不能选择或覆盖它们。
 * =================================================================== */

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const idColumn = () => integer('id').primaryKey({ autoIncrement: true })
const timestampColumn = (name) => integer(name).notNull().default(0)

export const project_list = sqliteTable('project_list', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  project_key: text('project_key').notNull(),
  name: text('name').notNull().default(''),
  description: text('description'),
  logo_url: text('logo_url').default(''),
  site_url: text('site_url').default(''),
  timezone: text('timezone').default(''),
  priority: integer('priority').default(0),
  status: integer('status').default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('project_list_project_key_uidx').on(table.project_id, table.project_key),
  index('project_list_owner_status_idx').on(table.project_id, table.union_id, table.status),
  index('project_list_priority_idx').on(table.project_id, table.priority),
])

export const project_data_source = sqliteTable('project_data_source', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  project_key: text('project_key').notNull(),
  provider: text('provider').notNull(),
  auth_id: integer('auth_id').notNull(),
  resource_id: text('resource_id').notNull(),
  resource_label: text('resource_label').default(''),
  resource_meta: text('resource_meta'),
  realtime_dashboard: integer('realtime_dashboard').default(1),
  status: integer('status').default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  index('project_data_source_project_idx').on(table.project_id, table.project_key),
  index('project_data_source_provider_idx').on(table.project_id, table.union_id, table.provider),
  uniqueIndex('project_data_source_resource_uidx').on(table.project_id, table.project_key, table.provider, table.resource_id),
  index('project_data_source_auth_idx').on(table.auth_id),
])

export const data_source_auth = sqliteTable('data_source_auth', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  provider: text('provider').notNull(),
  external_id: text('external_id').notNull().default(''),
  account_email: text('account_email').default(''),
  account_name: text('account_name').default(''),
  account_avatar: text('account_avatar').default(''),
  access_token_enc: text('access_token_enc'),
  refresh_token_enc: text('refresh_token_enc'),
  token_expires_at: integer('token_expires_at').default(0),
  scope: text('scope'),
  last_refreshed_at: integer('last_refreshed_at').default(0),
  status: integer('status').default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  index('data_source_auth_provider_idx').on(table.project_id, table.union_id, table.provider),
  uniqueIndex('data_source_auth_external_uidx').on(table.project_id, table.union_id, table.provider, table.external_id),
  index('data_source_auth_status_idx').on(table.project_id, table.status),
])

export const metrics_cache = sqliteTable('metrics_cache', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  cache_key: text('cache_key').notNull(),
  payload: text('payload').notNull(),
  expires_at: timestampColumn('expires_at'),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('metrics_cache_key_uidx').on(table.project_id, table.cache_key),
  index('metrics_cache_expires_idx').on(table.expires_at),
  index('metrics_cache_updated_idx').on(table.updated_at),
])

export const user_api_key = sqliteTable('user_api_key', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  key_name: text('key_name').notNull().default(''),
  api_key: text('api_key').notNull(),
  last_used_at: integer('last_used_at').default(0),
  status: integer('status').default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('user_api_key_value_uidx').on(table.api_key),
  index('user_api_key_owner_status_idx').on(table.project_id, table.union_id, table.status),
])

export const project_funnel = sqliteTable('project_funnel', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  project_key: text('project_key').notNull(),
  funnel_key: text('funnel_key').notNull(),
  name: text('name').notNull().default(''),
  steps_config: text('steps_config'),
  status: integer('status').default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('project_funnel_key_uidx').on(table.project_id, table.funnel_key),
  index('project_funnel_project_status_idx').on(table.project_id, table.project_key, table.status),
  index('project_funnel_owner_status_idx').on(table.project_id, table.union_id, table.status),
])

export const public_profile = sqliteTable('public_profile', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  slug: text('slug').notNull(),
  slug_source: text('slug_source').notNull().default('email'),
  display_name: text('display_name').notNull().default(''),
  avatar_url: text('avatar_url').notNull().default(''),
  bio: text('bio'),
  visibility_mode: text('visibility_mode').notNull().default('semi_public'),
  show_branding: integer('show_branding').notNull().default(1),
  social_links: text('social_links'),
  website_url: text('website_url').notNull().default(''),
  theme_key: text('theme_key').notNull().default('default'),
  status: integer('status').notNull().default(97),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('public_profile_owner_uidx').on(table.project_id, table.union_id),
  uniqueIndex('public_profile_slug_uidx').on(table.project_id, table.slug),
  index('public_profile_status_idx').on(table.project_id, table.status),
])

export const public_project_setting = sqliteTable('public_project_setting', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  project_key: text('project_key').notNull(),
  public_project_key: text('public_project_key').notNull(),
  visibility_mode: text('visibility_mode').notNull().default('inherit'),
  password_hash: text('password_hash').notNull().default(''),
  anonymous_label: text('anonymous_label').notNull().default(''),
  public_title: text('public_title').notNull().default(''),
  public_description: text('public_description'),
  priority: integer('priority').notNull().default(0),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('public_project_setting_project_uidx').on(table.project_id, table.project_key),
  uniqueIndex('public_project_setting_public_uidx').on(table.project_id, table.public_project_key),
  index('public_project_setting_owner_idx').on(table.project_id, table.union_id),
  index('public_project_setting_visibility_idx').on(table.project_id, table.union_id, table.visibility_mode),
])

export const public_widget = sqliteTable('public_widget', {
  id: idColumn(),
  project_id: text('project_id').notNull(),
  union_id: text('union_id').notNull(),
  widget_key: text('widget_key').notNull(),
  scope: text('scope').notNull().default('profile'),
  project_key: text('project_key').notNull().default(''),
  widget_type: text('widget_type').notNull().default('metric_card'),
  visibility_mode: text('visibility_mode').notNull().default('semi_public'),
  metric: text('metric').notNull().default('totalUsers'),
  period: text('period').notNull().default('28days'),
  title: text('title').notNull().default(''),
  theme: text('theme').notNull().default('light'),
  accent_color: text('accent_color').notNull().default(''),
  config_json: text('config_json'),
  status: integer('status').notNull().default(1),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('public_widget_key_uidx').on(table.project_id, table.widget_key),
  index('public_widget_owner_idx').on(table.project_id, table.union_id),
  index('public_widget_status_idx').on(table.project_id, table.status),
])

export const usage_records = sqliteTable('usage_records', {
  id: idColumn(),
  project_id: text('project_id').notNull().default('self-hosted'),
  key_name: text('key_name').notNull(),
  date: text('date').notNull(),
  count: integer('count').notNull().default(0),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
}, (table) => [
  uniqueIndex('usage_records_key_date_uidx').on(table.key_name, table.date),
  index('usage_records_updated_idx').on(table.updated_at),
])

/* ---- 单实例初始化与运行配置：固定 id=1，不承载多租户语义 ---- */
export const instance_config = sqliteTable('instance_config', {
  id: integer('id').primaryKey(),
  admin_email: text('admin_email').notNull().default(''),
  admin_password_hash: text('admin_password_hash').notNull().default(''),
  auth_version: integer('auth_version').notNull().default(1),
  google_client_id: text('google_client_id').notNull().default(''),
  google_client_secret_enc: text('google_client_secret_enc').notNull().default(''),
  custom_origin: text('custom_origin').notNull().default(''),
  created_at: timestampColumn('created_at'),
  updated_at: timestampColumn('updated_at'),
})

// Overview invalidation must survive empty caches and separate Worker instances.
export const metrics_cache_versions = sqliteTable('metrics_cache_versions', {
  project_id: text('project_id').primaryKey(),
  version: integer('version').notNull().default(0),
})
