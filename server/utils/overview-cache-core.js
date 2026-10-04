const INVALIDATED = Symbol('invalidated')

// readVersion is persistent; write must atomically reject an obsolete version.
export function createOverviewCache({ read, readVersion, write, now = () => Math.floor(Date.now() / 1000) }) {
  const pending = new Map()
  const retryAfter = new Map()
  const backoff = key => {
    retryAfter.delete(key)
    retryAfter.set(key, now() + 30)
    if (retryAfter.size > 256) retryAfter.delete(retryAfter.keys().next().value)
  }

  return async function load({ key, refresh = false, build, waitUntil }) {
    // A mutation can finish while either the cache read or rebuild is in flight.
    // Retry with fresh inputs, but do not loop forever under continuous mutations.
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await readVersion(key)
      const entry = await read(key)
      if (await readVersion(key) !== version) continue
      const workKey = JSON.stringify([key, version])
      const cached = (refreshing = false) => ({
        ...entry.payload,
        from_cache: true,
        cache_state: entry.state,
        cached_at: entry.updatedAt,
        refreshing,
      })
      if (!refresh && entry?.state === 'hit') return cached()

      const rebuild = () => {
        if (!pending.has(workKey)) {
          const work = Promise.resolve().then(build).then(async payload => {
            if (await readVersion(key) !== version) return INVALIDATED
            if (payload.partial) {
              backoff(workKey)
              if (entry) return { ...cached(), cache_state: 'stale', refresh_failed: true }
              // A partial result is displayable, but must not become a snapshot.
              return { ...payload, cached_at: now(), refreshing: false }
            }
            const result = { ...payload, cached_at: now(), refreshing: false }
            if (!await write(key, result, version)) return INVALIDATED
            retryAfter.delete(workKey)
            return await readVersion(key) === version ? result : INVALIDATED
          }).catch(async error => {
            if (await readVersion(key) !== version) return INVALIDATED
            backoff(workKey)
            if (entry) return { ...cached(), cache_state: 'stale', refresh_failed: true }
            throw error
          }).finally(() => pending.delete(workKey))
          pending.set(workKey, work)
        }
        return pending.get(workKey)
      }

      // Without a platform lifetime hook, await the rebuild instead of starting
      // fire-and-forget work that can be terminated after the response.
      if (!refresh && entry && waitUntil) {
        for (const [key, until] of retryAfter) {
          if (until <= now()) retryAfter.delete(key)
        }
        if ((retryAfter.get(workKey) || 0) <= now()) {
          waitUntil(rebuild().catch(error => {
            console.error('[overview-cache] background refresh failed:', error?.message)
          }))
        }
        return cached(pending.has(workKey))
      }
      const result = await rebuild()
      if (result !== INVALIDATED) return result
    }
    const error = new Error('overview_cache_invalidated')
    error.statusCode = 503
    throw error
  }
}
