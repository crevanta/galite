// Keep public errors actionable without exposing Google's raw response or credentials.
const DISABLED_SERVICES = {
  'analyticsadmin.googleapis.com': 'ga4_admin_api_disabled',
  'searchconsole.googleapis.com': 'gsc_api_disabled',
}

export function googleApiErrorCode(text, fallback) {
  try {
    const details = JSON.parse(text)?.error?.details
    if (!Array.isArray(details)) return fallback
    for (const detail of details) {
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
        && detail.domain === 'googleapis.com'
        && detail.reason === 'SERVICE_DISABLED') {
        const code = DISABLED_SERVICES[detail.metadata?.service]
        if (code) return code
      }
    }
  } catch { /* Non-JSON responses retain the existing generic error. */ }
  return fallback
}

export function publicSyncErrorCode(error) {
  return Object.values(DISABLED_SERVICES).includes(error?.message)
    ? error.message
    : 'sync_incomplete'
}
