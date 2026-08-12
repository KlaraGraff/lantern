import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * 本地转发：页面把 LLM 请求发给同源的 /llm-proxy（真实地址放在
 * x-proxy-target 头里），由 dev server 在本机转发。浏览器直连第三方
 * 中转站会被 CORS 预检挡死（服务器对服务器没有这一说），Lantern 靠
 * 桌面端后台代发解决，纯前端的对应物就是这个中间件。仅开发服务器有效；
 * 静态部署时走浏览器直连，要求服务商自身放行 CORS。
 */
function llmProxy(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const target = req.headers['x-proxy-target']
      if (req.method !== 'POST' || typeof target !== 'string' || !/^https?:\/\//.test(target)) {
        res.statusCode = 400
        res.end('llm-proxy: 需要 POST 且 x-proxy-target 为完整 http(s) 地址')
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (typeof req.headers.authorization === 'string') {
        headers.authorization = req.headers.authorization
      }
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers,
          body: Buffer.concat(chunks),
        })
        res.statusCode = upstream.status
        // 只透传 content-type：fetch 已解压，content-encoding/length 不再成立
        const ct = upstream.headers.get('content-type')
        if (ct) res.setHeader('content-type', ct)
        res.setHeader('cache-control', 'no-cache')
        if (!upstream.body) {
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      } catch (err) {
        res.statusCode = 502
        res.end(`llm-proxy 转发失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm-proxy', handler)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), llmProxy()],
  test: {
    environment: 'node',
  },
})
