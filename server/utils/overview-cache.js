import { createOverviewCache } from './overview-cache-core.js'
import { readCacheEntry } from './metrics-cache'

import { readOverviewVersion, writeOverviewCache } from './overview-cache-version'

export const OVERVIEW_CACHE_TTL_SECONDS = 5 * 60
export const OVERVIEW_STALE_SECONDS = 24 * 60 * 60

// Each database binding gets its own request pool. Concurrent visits share one rebuild.
const pools = new WeakMap()

export async function loadOverviewCache({ event, db, projectId, cacheKey, refresh, build }) {
  const binding = event.context.cloudflare.env.DB
  let load = pools.get(binding)
  if (!load) {
    load = createOverviewCache({
      read: key => {
        const [project, cache] = JSON.parse(key)
        return readCacheEntry(db, project, cache, { staleTtlSeconds: OVERVIEW_STALE_SECONDS })
      },
      readVersion: key => readOverviewVersion(db, JSON.parse(key)[0]),
      write: (key, payload, version) => {
        const [project, cache] = JSON.parse(key)
        return writeOverviewCache(db, project, cache, payload, OVERVIEW_CACHE_TTL_SECONDS, version)
      },
    })
    pools.set(binding, load)
  }
  return load({
    key: JSON.stringify([projectId, cacheKey]), refresh, build,
    waitUntil: event.context.cloudflare.context?.waitUntil
      ? promise => event.context.cloudflare.context.waitUntil(promise)
      : undefined,
  })
}
