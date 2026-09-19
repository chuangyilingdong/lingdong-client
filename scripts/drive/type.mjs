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
const click = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await new Promise((r) => setTimeout(r, 120));
  }
};
const shot = async (name) => { const reply = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`.tmp/bench-shots/${name}.png`, Buffer.from(reply.result.data, 'base64')); };

const text = process.argv[2] || '你好';
// ① 找到输入框（contenteditable 的那个）
const box = await evaluate(`(() => { const n = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: n.tagName, cls: String(n.className).slice(0, 40) }; })()`);
console.log('输入框：', JSON.stringify(box));
await click(box.x, box.y);
await new Promise((r) => setTimeout(r, 400));
// ② 真实输入（走 Chromium 的输入管线，React 才看得见）
await send('Input.insertText', { text });
await new Promise((r) => setTimeout(r, 600));
console.log('输入后输入框内容：', JSON.stringify(await evaluate(`(() => { const n = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]'); return n.tagName === 'TEXTAREA' ? n.value : n.innerText; })()`)));
await shot('composer-typed');
// ③ 回车发送
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await new Promise((r) => setTimeout(r, 150));
}
console.log('已回车');
process.exit(0);
