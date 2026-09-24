/**
 * P122 平台契约端到端探针（2026-09-23）。
 *
 * 为什么要有它：客户端能不能上课，只取决于**平台那条链**与 `platform-gate.ts` 的假设是否一致——
 * 路径、请求体形状、返回字段、错误码。这些在平台侧改动（换域名 / 换 OSS / 换 RDS / 改路由）
 * 时最容易悄悄漂掉，而单元测试打的是桩、看不见。
 *
 * 它逐条重放客户端真实调用（读 `deploy/desktop/client-patch/platform-gate.ts`）：
 *   ① POST /api/auth/login                     { login, password }        → { token, user }
 *   ② GET  /api/student/runtime/client-context  Bearer                    → { classroom, gateway, sends, presets, ... }
 *   ③ POST <gateway.baseUrl>/chat/completions   Bearer gateway.key        → OpenAI 兼容回复
 *   ④ GET  /api/student/runtime/client-context 再次                        → sends 恰好 +1（平台侧验收判据）
 *   ⑤ GET  /api/student/works?page=1&limit=20                              → { items | works, total }
 *   ⑥ POST /api/student/runtime/submit-upload   multipart                  → 交作品成功
 *   ⑦ GET  /api/student/works                                              → 新作品出现
 *   ⑧ POST /api/auth/logout
 *
 * 跑法：
 *   node scripts/dev-bench.mjs                 # 平台仓库里起临时台（默认 18910）
 *   node scripts/p122-platform-contract.mjs    # 客户端仓库里跑这条
 * 可用 LINGDONG_API_BASE 覆盖地址，LINGDONG_TEST_LOGIN / _PASSWORD 覆盖账号。
 */
import assert from 'node:assert/strict'

const API_BASE = (process.env.LINGDONG_API_BASE || 'http://127.0.0.1:18910').replace(/\/+$/u, '')
const LOGIN = process.env.LINGDONG_TEST_LOGIN || 'student-1'
const PASSWORD = process.env.LINGDONG_TEST_PASSWORD || 'study123'

const checks = []
const check = async (name, run) => {
  try {
    const detail = await run()
    checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) })
  } catch (error) {
    checks.push({ name, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

async function call(path, { method = 'GET', body, token, headers = {}, raw = false } = {}) {
  const init = {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  }
  const response = await fetch(`${API_BASE}${path}`, init)
  const text = await response.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
  if (!response.ok) {
    // 平台错误体是 { error: { code, message } }（与客户端 PlatformRequestError 读法一致）
    const code = parsed?.error?.code
    const message = parsed?.error?.message || parsed?.message || text.slice(0, 200)
    throw new Error(`${method} ${path} → ${response.status}${code ? ` [${code}]` : ''} ${String(message)}`)
  }
  // ⚠️ 必须与 platform-gate.ts 的 call() 一致：平台统一信封是 { success, ok, data }，
  //    客户端只取 data。漏了这一步会把「登录成功」误判成「没有 token」。
  return parsed?.data ?? parsed
}

let token = ''
let context
let probeWorkName = ''
let firstSends

await check('① 登录 POST /api/auth/login', async () => {
  const session = await call('/api/auth/login', { method: 'POST', body: { login: LOGIN, password: PASSWORD } })
  assert.ok(session?.token, '返回里没有 token')
  token = session.token
  return { user: session.user?.displayName ?? session.user?.login ?? '(未命名)' }
})

await check('② 课堂上下文 GET /api/student/runtime/client-context', async () => {
  context = await call('/api/student/runtime/client-context', { token })
  assert.ok(context?.classroom?.id, `没有可进课堂（reason=${context?.reason ?? '-'} message=${context?.message ?? '-'}）`)
  assert.ok(context.gateway?.key, 'context.gateway.key 缺失（客户端就靠它调模型）')
  assert.ok(context.gateway?.baseUrl, 'context.gateway.baseUrl 缺失')
  assert.ok(context.sends, 'context.sends 缺失（发送次数显示要用）')
  assert.ok(Array.isArray(context.presets), 'context.presets 不是数组')
  assert.ok(Array.isArray(context.models), 'context.models 缺失或不是数组（平台契约字段漂了）')
  assert.ok(context.models.every((item) => typeof item?.id === 'string' && item.id.trim() && typeof item.displayName === 'string' && item.displayName.trim()),
    `context.models 形状不对：${JSON.stringify(context.models).slice(0, 200)}`)
  assert.ok(typeof context.defaultModel === 'string', 'context.defaultModel 缺失或不是字符串')
  // 验证台/local-mock 可以合法地没有配置 TEXT 渠道，此时客户端走内置兜底；
  // 一旦平台下发了模型，默认值必须能在清单里选中。
  if (context.models.length > 0) {
    assert.ok(context.defaultModel.trim(), '有 models 时 defaultModel 为空')
    assert.ok(context.models.some((item) => item.id === context.defaultModel), 'context.defaultModel 不在 models 清单中')
  }
  firstSends = context.sends
  return {
    classroom: context.classroom.id,
    sends: `${firstSends.used}/${firstSends.limit}`,
    presets: context.presets.length,
    models: context.models.length,
    defaultModel: context.defaultModel,
  }
})

await check('③ 网关调用（客户端实际发的 OpenAI 兼容请求）', async () => {
  // ⚠️ 平台的 `vibecoding_sends` 不是「请求次数」，而是**请求体里 user 消息条数的单调最大值**
  //    （见平台 vibecodingLessonSettings.js：学生压缩历史不能刷新额度）。
  //    所以这里按「第 N+1 次发送」的真实形态组一段 history：N+1 条 user。
  const turns = firstSends.used + 1
  const messages = []
  for (let i = 1; i <= turns; i += 1) {
    messages.push({ role: 'user', content: `P122 契约探针第 ${i} 次发送（${Date.now()}）` })
    if (i < turns) messages.push({ role: 'assistant', content: '好的，我继续。' })
  }
  const gatewayModel = context.defaultModel || context.models[0]?.id || 'deepseek-flash'
  const url = `${String(context.gateway.baseUrl).replace(/\/+$/u, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.gateway.key}` },
    body: JSON.stringify({ model: gatewayModel, messages, stream: false }),
  })
  const text = await response.text()
  assert.ok(response.ok, `网关 ${response.status}：${text.slice(0, 300)}`)
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`网关返回不是 JSON：${text.slice(0, 200)}`) }
  const content = parsed?.choices?.[0]?.message?.content
  assert.ok(typeof content === 'string' && content.length > 0, `网关没有返回内容：${text.slice(0, 200)}`)
  return { userTurns: turns, model: gatewayModel, reply: content.slice(0, 40) }
})

await check('④ 发送次数单调推到 N+1（平台侧验收判据）', async () => {
  // 计量异步落库：轮询一小段时间再判。
  const expected = firstSends.used + 1
  let after
  for (let attempt = 0; attempt < 10; attempt += 1) {
    after = await call('/api/student/runtime/client-context', { token })
    if (after?.sends?.used === expected) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(after.sends, 'sends 缺失')
  assert.equal(after.sends.used, expected,
    `发送次数应为 ${expected}，实际 ${after.sends.used}（平台的 seen 是新历史 user 条数的单调最大值）`)
  return `${firstSends.used} → ${after.sends.used} / ${after.sends.limit}`
})
await check('⑤ 我的作品列表 GET /api/student/works', async () => {
  const works = await call('/api/student/works?page=1&limit=20', { token })
  const list = works?.items ?? works?.works ?? works?.list
  assert.ok(Array.isArray(list), `作品列表形状变了：${JSON.stringify(works).slice(0, 200)}`)
  return { total: works.total ?? list.length }
})

await check('⑥ 交作品 POST /api/student/runtime/submit-upload', async () => {
  // ⚠️ 必须与 platform-gate.ts 的 submitWork() 完全一致：JSON（不是 multipart），
  //    且必须带 copyrightConfirmed: true —— 缺了会被自己的门禁判 WORK_COPYRIGHT_CONFIRMATION_REQUIRED。
  const name = `p122-probe-${Date.now()}.html`
  const html = `<html><body><h1>P122 contract probe</h1><p>${new Date().toISOString()}</p></body></html>`
  const body = {
    name,
    title: 'P122 契约探针',
    copyrightConfirmed: true,
    files: [{ name, content: html, binary: false }],
  }
  const path = `/api/student/runtime/submit-upload?sessionId=${encodeURIComponent(context.classroom.id)}`
  const parsed = await call(path, { method: 'POST', token, body })
  assert.ok(parsed?.ok !== false, `交作品被拒：${JSON.stringify(parsed).slice(0, 300)}`)
  probeWorkName = name
  return { name, keys: Object.keys(parsed ?? {}).slice(0, 5).join(',') }
})
await check('⑦ 新作品出现在 /api/student/works', async () => {
  const works = await call('/api/student/works?page=1&limit=20', { token })
  const list = works?.items ?? works?.works ?? works?.list ?? []
  const hit = JSON.stringify(list).includes(probeWorkName.replace(/\.html$/u, ''))
  assert.ok(hit, '刚提交的作品没出现在列表里')
  return { found: probeWorkName }
})

await check('⑧ 注销 POST /api/auth/logout', async () => {
  await call('/api/auth/logout', { method: 'POST', token })
  return 'ok'
})

for (const item of checks) {
  console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.detail === undefined ? '' : ` → ${JSON.stringify(item.detail)}`}`)
  if (!item.ok) console.log(`      ${item.message}`)
}
const failed = checks.filter(item => !item.ok)
console.log(JSON.stringify({ name: 'p122-platform-contract', base: API_BASE, pass: failed.length === 0, checks: checks.length, failed: failed.map(item => item.name) }))
process.exitCode = failed.length === 0 ? 0 : 1
