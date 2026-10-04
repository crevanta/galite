import assert from 'node:assert/strict'
import test from 'node:test'
import { googleApiErrorCode, publicSyncErrorCode } from '../server/utils/google-api-error.js'

const response = (service, reason = 'SERVICE_DISABLED') => JSON.stringify({error:{details:[{
  '@type':'type.googleapis.com/google.rpc.ErrorInfo', domain:'googleapis.com', reason, metadata:{service},
}]}})

test('disabled Google APIs remain distinguishable from missing user permissions', () => {
  for (const [service, code] of [['analyticsadmin.googleapis.com','ga4_admin_api_disabled'],['searchconsole.googleapis.com','gsc_api_disabled']]) {
    const parsed=googleApiErrorCode(response(service),'permission_denied')
    assert.equal(parsed,code)
    assert.equal(publicSyncErrorCode(new Error(parsed)),code)
    assert.equal(googleApiErrorCode(response(service,'ACCESS_TOKEN_SCOPE_INSUFFICIENT'),'permission_denied'),'permission_denied')
  }
})

test('malformed or unrecognized upstream responses cannot expose raw details', () => {
  for(const body of ['<html>bad gateway</html>','{}','{"error":{"details":{}}}',response('unknown.googleapis.com')]) {
    assert.equal(googleApiErrorCode(body,'permission_denied'),'permission_denied')
  }
  assert.equal(publicSyncErrorCode(new Error('upstream private details')),'sync_incomplete')
  assert.equal(publicSyncErrorCode(null),'sync_incomplete')
})
