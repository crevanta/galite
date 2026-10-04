const STORAGE_KEY = 'galite:project-snapshots:v1'
const REVISION_KEY = `${STORAGE_KEY}:revision`
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_PERIODS = 8
const memoryRevisions = new WeakMap()

export function snapshotOwner(user) {
  return user?.email && user?.union_id
    ? JSON.stringify([user.project_id, user.union_id, user.email.toLowerCase()])
    : ''
}

// Only overview display data is stored. Login still comes from the server session.
export function createProjectSnapshotCache(storage, now = Date.now) {
  const revision = () => {
    const memory = storage ? memoryRevisions.get(storage) || '' : ''
    try { return `${memory}:${storage?.getItem(REVISION_KEY) || ''}` } catch { return memory }
  }
  const rows = () => {
    try {
      const value = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]')
      return Array.isArray(value) ? value : []
    } catch { return [] }
  }
  const valid = (payload, period) => !payload?.partial && payload?.period === period
    && Array.isArray(payload.projects)
    && Number.isFinite(payload.cached_at)
    && payload.cached_at * 1000 <= now() + 60000
    && payload.cached_at * 1000 > now() - MAX_AGE_MS
  return {
    revision,
    read(owner, period) {
      if (!owner) return null
      const row = rows().find(item => item?.owner === owner && item.period === period)
      if (!row) return null
      const result = Object.fromEntries(['ga4', 'search']
        .filter(provider => valid(row[provider], period))
        .map(provider => [provider, row[provider]]))
      return Object.keys(result).length ? result : null
    },
    write(owner, period, provider, payload, expectedRevision) {
      if (!owner || !['ga4', 'search'].includes(provider) || !valid(payload, period)
        || expectedRevision !== revision()) return
      try {
        const remaining = rows().filter(item => item?.owner === owner
          && item.period !== period
          && ['ga4', 'search'].some(key => valid(item[key], item.period)))
        const previous = rows().find(item => item?.owner === owner && item.period === period) || {}
        // Explicit display-field allowlist; never persist tokens or authorization records.
        const display = Object.fromEntries([
          'period', 'projects', 'totals', 'sparkline', 'provider_totals',
          'sparkline_clicks', 'sparkline_impressions', 'cached_at', 'partial',
        ].filter(key => payload[key] !== undefined).map(key => [key, payload[key]]))
        const row = { ...previous, owner, period, [provider]: display }
        storage?.setItem(STORAGE_KEY, JSON.stringify([row, ...remaining].slice(0, MAX_PERIODS)))
      } catch { /* Full/disabled browser storage must not block the live dashboard. */ }
    },
    clear() {
      const next = `${now()}:${Math.random()}`
      if (storage) memoryRevisions.set(storage, next)
      try { storage?.setItem(REVISION_KEY, next) } catch { /* Quota may be exhausted. */ }
      try { storage?.removeItem(STORAGE_KEY) } catch { /* Storage may be disabled. */ }
    },
  }
}

export function projectSnapshotCache() {
  let storage
  try { if (typeof window !== 'undefined') storage = window.localStorage } catch {}
  return createProjectSnapshotCache(storage)
}
