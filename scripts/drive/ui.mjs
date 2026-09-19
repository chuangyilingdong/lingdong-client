import fs from 'node:fs';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const app = list.find((t) => t.url.startsWith('dsh-app://'));
const ws = new WebSocket(app.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 300));
  return reply.result?.result?.value;
};
const step = process.argv[2];
if (step === 'dump') {
  console.log(JSON.stringify(await evaluate(`(() => [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')].map((n) => ({ tag: n.tagName, text: (n.textContent || '').trim().slice(0, 24), cls: String(n.className).slice(0, 40), disabled: n.disabled === true })).slice(0, 30))()`), null, 1));
} else if (step === 'click') {
  const text = process.argv[3];
  console.log(await evaluate(`(() => { const node = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a')].find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)})); if (!node) return '没找到：' + ${JSON.stringify(text)}; node.click(); return '点了：' + (node.textContent || '').trim().slice(0, 30); })()`));
} else if (step === 'text') {
  console.log((await evaluate('document.body.innerText')).replace(/\n+/g, ' / ').slice(0, 700));
} else if (step === 'shot') {
  const reply = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`.tmp/bench-shots/${process.argv[3] || 'ui'}.png`, Buffer.from(reply.result.data, 'base64'));
  console.log('ok');
}
process.exit(0);
