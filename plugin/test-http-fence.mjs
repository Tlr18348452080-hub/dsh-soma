/**
 * /api/soma/* 信任栅栏的回归测试。
 *
 * 背景：这条前缀比内核的 /api 长，webServer 按最长前缀分发，所以请求先到插件手里，
 * 内核的准入不会替它把关。这里逐条钉住「什么样的请求该被拒」。
 *
 *   node plugin/test-http-fence.mjs
 */

import { apply, somaHttpRejection } from './lib/index.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) return console.log('  ok   ' + name)
  failed++
  console.log('  FAIL ' + name + (extra ? '  ← ' + extra : ''))
}

/* ── 1. 纯函数：结构化栅栏（没有宿主 connection 服务时走这条） ── */
console.log('\n[1] 没有宿主栅栏时，只放本机同源')
const plain = (headers) => somaHttpRejection({ headers }, undefined)

ok('loopback + 同源 origin → 放行', plain({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }) === undefined)
ok('localhost → 放行', plain({ host: 'localhost:3080' }) === undefined)
ok('127.0.0.5 → 放行', plain({ host: '127.0.0.5:3080' }) === undefined)
ok('::1 → 放行', plain({ host: '[::1]:3080' }) === undefined)
ok('外部 Host → 403', plain({ host: 'evil.example:3080' }) === 403)
ok('仿冒回环域名 → 403', plain({ host: '127.0.0.1.evil.example' }) === 403)
ok('缺 Host → 403', plain({}) === 403)
ok('畸形 Host → 403', plain({ host: 'not a host' }) === 403)
ok('cross-site → 403', plain({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }) === 403)
ok('跨源 Origin → 403', plain({ host: '127.0.0.1:3080', origin: 'http://evil.example' }) === 403)
ok('畸形 Origin → 403', plain({ host: '127.0.0.1:3080', origin: 'not a url' }) === 403)
ok('Origin: null → 放行（同源空来源）', plain({ host: '127.0.0.1:3080', origin: 'null' }) === undefined)

/* ── 2. 纯函数：委托宿主 connection ── */
console.log('\n[2] 有宿主栅栏时，判定权交给它')
const withConn = (conn) => (headers) => somaHttpRejection({ headers }, conn)

ok('requestRejection 放行 → 放行', withConn({ requestRejection: () => undefined })({ host: 'evil.example' }) === undefined)
ok('requestRejection 401 → 401', withConn({ requestRejection: () => 401 })({ host: '127.0.0.1:3080' }) === 401)
ok('requestRejection 抛异常 → 503（fail-closed）', withConn({ requestRejection: () => { throw new Error('boom') } })({ host: '127.0.0.1:3080' }) === 503)
ok('admit({rejection:403}) → 403', withConn({ admit: () => ({ rejection: 403 }) })({ host: '127.0.0.1:3080' }) === 403)
ok('admit(undefined) → 放行', withConn({ admit: () => undefined })({ host: '127.0.0.1:3080' }) === undefined)
ok('取服务本身抛异常 → 走结构校验', somaHttpRejection({ headers: { host: 'evil.example' } }, () => { throw new Error('no service') }) === 403)

/* ── 3. 挂到 webServer 上以后，路由真的被挡住 ── */
console.log('\n[3] 路由层：handler 第一行就是栅栏')
let captured = null
let conn
const ctx = {
  get: (name) => (name === 'webServer' ? ctx.webServer : name === 'connection' ? conn : undefined),
  webServer: { register: (route) => { captured = route; return () => {} } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
  inject: (services, fn) => { if (services.includes('webServer')) fn(ctx) },
}
apply(ctx, { statePath: '/tmp/dsh-soma-fence-test-state.json', tickMs: 60000 })

const call = (handler, { method = 'GET', url = '/api/soma/panel', headers = {} } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; return this },
      write() {},
      end(body) { resolve({ status: this.statusCode, headers: this.headers, body: body == null ? '' : String(body) }) },
    }
    handler({ method, url, headers }, res)
  })

const loop = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
const denied = await call(captured.handler, { headers: { host: 'evil.example', origin: 'http://evil.example' } })
ok('外部页面 GET 面板 → 403', denied.status === 403, String(denied.status))
ok('被拒时没有吐面板 HTML', !denied.body.includes('<html'), denied.body.slice(0, 40))

conn = { requestRejection: () => 401 }
const unauth = await call(captured.handler, { headers: loop })
ok('宿主说没登录 → 401 原样透传', unauth.status === 401, String(unauth.status))

conn = { requestRejection: () => undefined }
const allowed = await call(captured.handler, { headers: loop })
ok('宿主放行 → 面板正常打开', allowed.status === 200 && allowed.body.includes('<html'), String(allowed.status))
ok('放行时 content-type 是 HTML', String(allowed.headers['content-type'] || '').includes('text/html'))

const crossPost = await call(captured.handler, { method: 'POST', url: '/api/soma/config', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })
ok('跨源 POST /api/soma/config → 403', crossPost.status === 403, String(crossPost.status))

console.log(failed ? `\n${failed} 项失败\n` : '\n全部通过\n')
process.exit(failed ? 1 : 0)
