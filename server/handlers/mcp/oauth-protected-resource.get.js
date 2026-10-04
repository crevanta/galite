/* ===================================================================
 * /.well-known/oauth-protected-resource - RFC 9728 (registered in nuxt.config.js)
 *
 * MCP client 在收到 401+WWW-Authenticate 后, 第一站会拉这里:
 *   - resource              : 受保护资源的 URL (即 MCP endpoint)
 *   - authorization_servers : 颁发 token 的 issuer (本站自己)
 *   - bearer_methods_supported / scopes_supported 提示 client 怎么持票
 *
 * 设计:
 *   - 同站既是 RS 又是 AS, 直接拿 origin 当 issuer.
 *   - 不缓存: 配置变化时 (域名切换) 立即生效.
 * =================================================================== */

import { resolveOrigin, MCP_SCOPE } from '../../utils/mcp-oauth'

export default defineEventHandler((event) => {
  const origin = resolveOrigin(event)
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Cache-Control', 'no-store')

  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_SCOPE],
    resource_documentation: `${origin}/api-docs`,
  }
})
