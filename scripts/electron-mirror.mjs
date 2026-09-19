// 本地 Electron 镜像（只为本机打包用，.tmp 是 gitignore）：把**已按官方 SHASUMS256.txt 校验过**的
// electron-v44.0.0-win32-x64.zip 与那份官方校验文件一起端出来，绕开这台机器打不通 GitHub release 的问题。
// ⚠️ 这不是关掉完整性校验：@electron/get 照样会拿 SHASUMS256.txt 校验 zip，只是取件通道换成了本机。
import fs from 'node:fs';
import http from 'node:http';
const PORT = Number(process.argv[2] || 18920);
const ZIP = 'C:/Users/Administrator/AppData/Local/electron/Cache/16cfa46effad3eaba32b3370f8ae31cae8ea2624490eaa5f736d489be8e9c6c4/electron-v44.0.0-win32-x64.zip';
const SHASUMS = '.tmp/electron-mirror/v44.0.0/SHASUMS256.txt';
http.createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = path.endsWith('SHASUMS256.txt') ? SHASUMS : (path.endsWith('.zip') ? ZIP : null);
  if (!file) { response.writeHead(404); response.end('not found'); return; }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(response);
  console.log(`[mirror] ${path} → ${file.split('/').pop()}`);
}).listen(PORT, '127.0.0.1', () => console.log(`Electron 镜像 http://127.0.0.1:${PORT}/v44.0.0/`));
