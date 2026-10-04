import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProjectIcon, resolveSiteFavicon } from '../app/utils/project-icon.js'

test('normalizes website and Search Console domain identifiers', () => {
  const expected = resolveSiteFavicon('https://example.com')
  for (const input of ['example.com', '//example.com', 'sc-domain:example.com', 'EXAMPLE.COM', 'example.com:8080/path']) {
    assert.equal(resolveSiteFavicon(input), expected, input)
  }
  assert.equal(new URL(expected).searchParams.get('sz'), '64')
})

test('only sends the hostname to the favicon service', () => {
  const result = new URL(resolveSiteFavicon('https://user:secret@example.com:8443/private?token=sensitive#fragment'))
  assert.equal(result.origin, 'https://www.google.com')
  assert.deepEqual([...result.searchParams], [['domain', 'example.com'], ['sz', '64']])
})

test('retains custom logos and returns an empty source for invalid websites', () => {
  assert.equal(resolveProjectIcon({ logo_url: ' /custom.svg ', site_url: 'example.com' }), '/custom.svg')
  assert.equal(resolveProjectIcon(null), '')
  for (const input of ['', null, 'not a url', 'javascript:alert(1)', 'data:image/png;base64,abc', 'ftp://example.com']) {
    assert.equal(resolveSiteFavicon(input), '', String(input))
  }
  assert.equal(resolveProjectIcon({ site_url: 'example.com' }), resolveSiteFavicon('example.com'))
})
