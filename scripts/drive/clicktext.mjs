import fs from 'node:fs';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const app = list.find((t) => t.url.startsWith('dsh-app://'));
const ws = new WebSocket(app.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 300));
  return reply.result?.result?.value;
};
const [text, shot] = process.argv.slice(2);
const target = await evaluate(`(() => {
  let best = null;
  for (const node of document.querySelectorAll('*')) {
    if ((node.innerText || '').trim() !== ${JSON.stringify(text)}) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const area = r.width * r.height;
    if (best === null || area < best.area) best = { area, x: r.x + r.width / 2, y: r.y + r.height / 2, tag: node.tagName, cls: String(node.className).slice(0, 40) };
  }
  return best;
})()`);
console.log('元素：', JSON.stringify(target));
if (target) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1, buttons: 1 });
    await new Promise((r) => setTimeout(r, 150));
  }
}
await new Promise((r) => setTimeout(r, 1500));
if (shot) { const reply = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`.tmp/bench-shots/${shot}.png`, Buffer.from(reply.result.data, 'base64')); }
console.log('正文：', String(await evaluate('document.body.innerText')).replace(/\n+/g, ' / ').slice(0, 240));
process.exit(0);
