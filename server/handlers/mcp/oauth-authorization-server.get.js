/* ===================================================================
 * /.well-known/oauth-authorization-server - RFC 8414 (registered in nuxt.config.js)
 *
 * MCP client (尤其 Claude Desktop / Cursor) 拿到这份 metadata 后, 自动:
 *   1. POST registration_endpoint 注册 client_id (Dynamic Client Registration)
 *   2. 浏览器跳 authorization_endpoint, 走 PKCE
 *   3. 用 code 换 token_endpoint 颁的 access_token
 *
 * 设计:
 *   - 公开客户端 (public client) only — 桌面 / IDE 类 MCP client 都没有
 *     server-side secret 可保管, PKCE S256 已经足够.
 *   - 不支持 client_credentials / implicit / password 等遗物 grant.
 * =================================================================== */

import { resolveOrigin, MCP_SCOPE } from '../../utils/mcp-oauth'

export default defineEventHandler((event) => {
  const origin = resolveOrigin(event)
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Cache-Control', 'no-store')

  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],            /* 公开客户端, 无 secret */
    scopes_supported: [MCP_SCOPE],
  }
})
