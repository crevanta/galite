export const DEFAULT_PROJECT_ICON_URL = '/images/icon/site-default.svg'

export function resolveSiteFavicon(siteUrl) {
  const value = String(siteUrl || '').trim().replace(/^sc-domain:/i, '')
  if (!value) return ''
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:]+:\d+(?:\/|$)/.test(value)
    const normalized = value.startsWith('//') ? `https:${value}` : hasScheme ? value : `https://${value}`
    const url = new URL(normalized)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return ''
    // Only send the hostname; paths, queries and credentials are unnecessary.
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`
  } catch {
    return ''
  }
}

export function resolveProjectIcon(project) {
  const logoUrl = String(project?.logo_url || '').trim()
  if (logoUrl) return logoUrl
  return resolveSiteFavicon(project?.site_url)
}
