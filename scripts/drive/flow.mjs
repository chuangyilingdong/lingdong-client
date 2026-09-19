// 裸 CDP 驱动本地客户端（Playwright 的 connectOverCDP 接 Electron 会超时，所以直接说协议）。
// 用法：
//   node .tmp/bench-flow.mjs ls              看有哪些页面
//   node .tmp/bench-flow.mjs shot <名>        截图当前门页面
//   node .tmp/bench-flow.mjs login            在登录门里填 student-1/study123 并提交
//   node .tmp/bench-flow.mjs app              等 dsh 界面出来（登录门放行之后）
//   node .tmp/bench-flow.mjs composer         看对话输入框长什么样
//   node .tmp/bench-flow.mjs send <文本>       在输入框里发一条消息
import fs from 'node:fs';
import path from 'node:path';

const STEP = process.argv[2] || 'ls';
const SHOTS = path.resolve('.tmp/bench-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CDP = 'http://127.0.0.1:9222';

const targets = async () => (await fetch(`${CDP}/json/list`)).json();

async function attach(match, { required = true } = {}) {
  const list = await targets();
  const target = list.find(match);
  if (!target) {
    if (required) throw new Error(`没找到目标页面。当前：\n${list.map((t) => `  ${t.type} ${t.url.slice(0, 90)}`).join('\n')}`);
    return null;
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(`页面里抛错：${JSON.stringify(reply.result.exceptionDetails).slice(0, 400)}`);
    return reply.result?.result?.value;
  };
  const screenshot = async (name) => {
    const reply = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(reply.result.data, 'base64'));
    return path.join(SHOTS, `${name}.png`);
  };
  return { target, evaluate, screenshot, send, close: () => socket.close() };
}

const isGate = (t) => t.url.includes('/gate/login.html');
const isDsh = (t) => t.type === 'page' && !t.url.startsWith('file://') && !t.url.startsWith('devtools://') && t.url !== 'about:blank';

if (STEP === 'ls') {
  for (const target of await targets()) {
    if (target.type !== 'page') continue;
    const session = await attach((t) => t.id === target.id, { required: false });
    const text = session ? await session.evaluate('document.body ? document.body.innerText.slice(0, 120) : ""').catch(() => '') : '';
    console.log(`${target.url.slice(0, 80)}\n  标题=${target.title || '（空）'}\n  文本=${String(text).replace(/\n+/g, ' / ').slice(0, 120)}`);
    session?.close();
  }
} else if (STEP === 'shot') {
  const session = (await attach(isGate, { required: false })) || await attach(isDsh);
  console.log('截图 →', await session.screenshot(process.argv[3] || 'shot'));
  session.close();
} else if (STEP === 'login') {
  const session = await attach(isGate);
  console.log('页面状态：', await session.evaluate('document.body.innerText.replace(/\\n+/g, " / ").slice(0, 200)'));
  await session.screenshot('gate-before-login');
  console.log('填表并提交：', await session.evaluate(`(() => {
    document.getElementById('login').value = 'student-1';
    document.getElementById('password').value = 'study123';
    document.getElementById('form').requestSubmit();
    return '已提交';
  })()`));
  await new Promise((resolve) => setTimeout(resolve, 6000));
  console.log('提交后：', await session.evaluate('document.body.innerText.replace(/\\n+/g, " / ").slice(0, 300)'));
  console.log('截图 →', await session.screenshot('gate-after-login'));
  session.close();
} else if (STEP === 'app') {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const session = await attach(isDsh, { required: false });
    if (session) {
      const text = await session.evaluate('document.body ? document.body.innerText : ""').catch(() => '');
      if (String(text).length > 60) {
        console.log('dsh 界面：', session.target.url.slice(0, 100));
        console.log('正文：', String(text).replace(/\n+/g, ' / ').slice(0, 400));
        console.log('截图 →', await session.screenshot('app'));
        session.close();
        process.exit(0);
      }
      session.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const session = (await attach(isGate, { required: false })) || await attach(isDsh);
  console.log('等不到 dsh 界面，当前那屏：', await session.evaluate('document.body.innerText.replace(/\\n+/g, " / ").slice(0, 300)'));
  console.log('截图 →', await session.screenshot('stuck'));
  session.close();
} else if (STEP === 'composer') {
  const session = await attach(isDsh);
  console.log(JSON.stringify(await session.evaluate(`(() => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], button')].map((node) => ({
    tag: node.tagName, cls: String(node.className).slice(0, 70), label: (node.getAttribute('placeholder') || node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40), disabled: node.disabled === true,
  })).slice(0, 25))()`), null, 1));
  session.close();
} else if (STEP === 'send') {
  const text = process.argv[3] || '帮我做一个自我介绍网页';
  const session = await attach(isDsh);
  const result = await session.evaluate(`(() => {
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!box) return '找不到输入框';
    box.focus();
    const text = ${JSON.stringify(text)};
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return '已写入：' + box.tagName;
  })()`);
  console.log(result);
  await new Promise((resolve) => setTimeout(resolve, 700));
  // 回车发送（dsh 的 composer 一般 Enter 发送）
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  }
  console.log('已回车；等 25 秒看回复…');
  await new Promise((resolve) => setTimeout(resolve, 25000));
  console.log('界面正文：', String(await session.evaluate('document.body.innerText')).replace(/\n+/g, ' / ').slice(0, 600));
  console.log('截图 →', await session.screenshot('after-send'));
  session.close();
} else {
  throw new Error(`未知步骤 ${STEP}`);
}
