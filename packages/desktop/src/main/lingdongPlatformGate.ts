import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

type LingdongUser = { readonly id?: string; readonly displayName?: string; readonly login?: string };
type LingdongClassroom = {
  readonly id: string;
  readonly lessonId?: string;
  readonly title?: string;
  readonly seriesTitle?: string;
  readonly lessonTitle?: string;
  readonly teacherName?: string;
  readonly startedAt?: string;
};
type LingdongContext = {
  readonly classroom: LingdongClassroom | null;
  readonly classrooms?: readonly LingdongGateClassroom[];
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string };
  readonly models?: readonly { readonly id?: unknown; readonly displayName?: unknown }[];
  readonly defaultModel?: unknown;
  readonly presets?: readonly { readonly title?: unknown; readonly text?: unknown }[];
  readonly sends?: { readonly limit?: number | null; readonly used?: number; readonly remaining?: number | null } | null;
  readonly workspacePath?: string;
  readonly message?: string;
  readonly sessionId?: string;
};
type LingdongSession = { readonly token: string; readonly user?: LingdongUser };
type LingdongGateClassroom = Readonly<{ id: string; title?: string; lessonId?: string; lessonTitle?: string; teacherName?: string }>;
type PendingLogin = Readonly<{ session: LingdongSession; login: string }>;
export type LingdongPlatformState = Readonly<{
  session: LingdongSession;
  context: LingdongContext;
  providerConfigPath: string;
  workspacePath: string;
  workspaceIdentity: string;
}>;

const API_BASE = String(process.env.LINGDONG_API_BASE || "https://aicyld.com").replace(/\/+$/u, "");
let activeState: LingdongPlatformState | null = null;
let providerConfigPath: string | null = null;
let gateWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let pendingLogin: PendingLogin | null = null;

function record<T>(value: unknown): value is Record<string, T> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFrom(value: unknown, fallback: string): string {
  if (record<unknown>(value)) {
    const error = value.error;
    if (typeof error === "string" && error.trim()) return error;
    if (record<unknown>(error) && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if (typeof value.message === "string" && value.message.trim()) return value.message;
  }
  return fallback;
}

async function apiRequest(path: string, init: RequestInit = {}, token?: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    throw new Error(messageFrom(payload, `平台请求失败（HTTP ${response.status}）`));
  }
  return payload;
}

function unwrap<T>(value: unknown): T {
  if (record<unknown>(value) && "data" in value) return value.data as T;
  return value as T;
}

function resolveWorkspace(context: LingdongContext, user: LingdongUser | undefined): string {
  const supplied = context.workspacePath?.trim();
  if (supplied) return supplied;
  const display = String(user?.displayName || user?.login || "学生").trim() || "学生";
  const classroom = context.classroom;
  const lesson = String(classroom?.lessonTitle || classroom?.title || classroom?.id || "课堂")
    .trim()
    .replace(/[<>:"/\\|?*]+/gu, "-") || "课堂";
  return join(app.getPath("documents"), "灵动ai创作", `${display}-${lesson}`);
}

async function buildProviderConfig(context: LingdongContext, token: string): Promise<string> {
  const gateway = context.gateway ?? {};
  const baseUrl = String(gateway.baseUrl || "").trim();
  if (!baseUrl) throw new Error("平台没有下发模型网关地址。");
  const models = (context.models ?? [])
    .map((item) => ({ id: String(item.id ?? "").trim(), displayName: String(item.displayName ?? "").trim() }))
    .filter((item) => item.id);
  const defaultModel = String(context.defaultModel ?? models[0]?.id ?? "deepseek-flash").trim();
  const modelIds = [...new Set([defaultModel, ...models.map((item) => item.id)])];
  const content = {
    schemaVersion: 1,
    revision: Date.now(),
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [{
          providerId: "lingdong-platform-gateway",
          providerName: "灵动ai 平台网关",
          config: {
            group: "standard-personal",
            builtinModelIds: modelIds,
            access: { type: "api-key", apiKey: String(gateway.key || token) },
            api: { type: "openai-chat-completions", baseUrl },
            visibility: "visible",
          },
        }],
      },
      modelConfigRules: {
        modelRules: modelIds.map((modelId) => ({
          providerId: "lingdong-platform-gateway",
          modelId,
          config: { enabled: true },
        })),
      },
    },
  };
  const dir = join(app.getPath("temp"), "lingdong-zcode");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `provider-${process.pid}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function handleLogin(payload: unknown): Promise<{ ok: true; user?: LingdongUser; classroom: LingdongClassroom; workspacePath: string } | { ok: false; message: string; classrooms?: readonly LingdongGateClassroom[] }> {
  try {
    const input = record<unknown>(payload) ? payload : {};
    const login = typeof input.login === "string" ? input.login.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    let session: LingdongSession;
    if (sessionId && pendingLogin) {
      session = pendingLogin.session;
    } else {
      if (!login || !password) return { ok: false, message: "请输入账号和密码。" };
      const rawSession = unwrap<Record<string, unknown>>(await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password }),
      }));
      const token = String(rawSession.token || rawSession.accessToken || "").trim();
      if (!token) throw new Error("平台登录响应缺少 token。");
      session = { token, user: record<unknown>(rawSession.user) ? rawSession.user as LingdongUser : undefined };
    }
    const contextPath = sessionId ? `/api/student/runtime/client-context?sessionId=${encodeURIComponent(sessionId)}` : "/api/student/runtime/client-context";
    const context = unwrap<LingdongContext>(await apiRequest(contextPath, {}, session.token));
    if (!sessionId && context.classrooms && context.classrooms.length > 1) {
      pendingLogin = { session, login };
      return { ok: false, message: "请选择要进入的课堂。", classrooms: context.classrooms };
    }
    pendingLogin = null;
    if (!context.classroom) throw new Error(context.message || "当前没有正在进行的课堂。");
    const workspacePath = resolveWorkspace(context, session.user);
    await mkdir(workspacePath, { recursive: true });
    const providerPath = await buildProviderConfig(context, token);
    if (providerConfigPath) await rm(providerConfigPath, { force: true }).catch(() => undefined);
    providerConfigPath = providerPath;
    activeState = {
      session,
      context,
      providerConfigPath: providerPath,
      workspacePath,
      workspaceIdentity: `${session.user?.id || session.user?.login || login}:${context.classroom.id}`,
    };
    process.env.LINGDONG_API_BASE = API_BASE;
    process.env.PLATFORM_GATEWAY_KEY = String(context.gateway?.key || token);
    process.env.PLATFORM_GATEWAY_BASE_URL = String(context.gateway?.baseUrl || "");
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = providerPath;
    process.env.ZCODE_LINGDONG_WORKSPACE_PATH = workspacePath;
    process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY = activeState.workspaceIdentity;
    process.env.ZCODE_LINGDONG_CLASSROOM_ID = context.classroom.id;
    process.env.ZCODE_LINGDONG_SEND_LIMIT = String(context.sends?.limit ?? "");
    process.env.ZCODE_LINGDONG_SEND_USED = String(context.sends?.used ?? 0);
    gateWindow?.close();
    return { ok: true, user: session.user, classroom: context.classroom, workspacePath };
  } catch (error) {
    pendingLogin = null;
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}



async function scanLingdongWorkspaceFiles(): Promise<unknown> {
  if (!activeState) return { ok: false, message: "平台登录尚未完成。", files: [] };
  const root = activeState.workspacePath;
  const allowed = new Set([".html", ".htm", ".docx", ".xlsx", ".pptx", ".md", ".png", ".jpg", ".jpeg"]);
  const files: Array<{ path: string; relativePath: string; size: number; updatedAt: number }> = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length && files.length < 500) {
    const current = queue.shift();
    if (!current || current.depth > 5) continue;
    let entries: Awaited<ReturnType<typeof readdir>> = [];
    try { entries = await readdir(current.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) { queue.push({ path, depth: current.depth + 1 }); continue; }
      const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "";
      if (!allowed.has(extension)) continue;
      try {
        const info = await stat(path);
        files.push({ path, relativePath: path.slice(root.length).replace(/^[\\/]+/u, "").replaceAll("\\", "/"), size: info.size, updatedAt: info.mtimeMs });
      } catch { /* ignore disappearing files */ }
      if (files.length >= 500) break;
    }
  }
  files.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ok: true, files, workspacePath: root, workspaceIdentity: activeState.workspaceIdentity };
}


type SubmitItem = Readonly<{ path?: unknown; relativePath?: unknown }>;
type WorkFilePayload = Readonly<{ name: string; content: string; binary: boolean }>;
const WORK_TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".htm", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".cjs",
  ".svg", ".text", ".ts", ".tsx", ".txt", ".webmanifest", ".xml", ".yaml", ".yml",
]);
const WORK_ALLOWED_EXTENSIONS = new Set([
  ".htm", ".html", ".docx", ".xlsx", ".pptx", ".md", ".txt", ".csv", ".json", ".js",
  ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".bmp", ".svg", ".mp3", ".wav", ".mp4", ".webm", ".mov", ".pdf",
]);
const MAX_WORK_FILES = 60;
const MAX_WORK_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_WORK_REQUEST_BYTES = 24 * 1024 * 1024;
const SUBMITTABLE_ENTRY_EXTENSIONS = new Set([".htm", ".html", ".docx", ".xlsx", ".pptx"]);

function pathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.includes(`..${sep}`));
}

async function prepareSubmitFiles(items: readonly SubmitItem[]): Promise<WorkFilePayload[]> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  const root = await realpath(activeState.workspacePath);
  const files: WorkFilePayload[] = [];
  let totalBytes = 0;
  const usedNames = new Set<string>();
  for (const item of items.slice(0, MAX_WORK_FILES)) {
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath || !pathInside(root, rawPath)) continue;
    const absolute = await realpath(rawPath).catch(() => "");
    if (!absolute || !pathInside(root, absolute)) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) continue;
    const extension = extname(absolute).toLowerCase();
    if (!WORK_ALLOWED_EXTENSIONS.has(extension)) continue;
    if (info.size > MAX_WORK_TOTAL_BYTES || totalBytes + info.size > MAX_WORK_TOTAL_BYTES) continue;
    const bytes = await readFile(absolute);
    // 平台作品协议要求文件名平铺，不能传目录分隔符；同名素材用序号区分。
    let name = basename(absolute);
    if (usedNames.has(name)) name = `${files.length}-${name}`;
    usedNames.add(name);
    const binary = !WORK_TEXT_EXTENSIONS.has(extension);
    files.push({ name, content: binary ? bytes.toString("base64") : bytes.toString("utf8"), binary });
    totalBytes += info.size;
  }
  if (files.length === 0) throw new Error("没有找到可以提交的作品文件。");
  return files;
}

async function submitWorkFromDesktop(payload: unknown): Promise<unknown> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  const input = record<unknown>(payload) ? payload : {};
  const rawItems = Array.isArray(input.items) ? input.items as SubmitItem[] : [];
  const files = await prepareSubmitFiles(rawItems);
  const entry = files.find((file) => SUBMITTABLE_ENTRY_EXTENSIONS.has(extname(file.name).toLowerCase()));
  if (!entry) throw new Error("请选择一个 HTML、PPT、Word 或 Excel 作为主作品文件。");
  const body: Record<string, unknown> = {
    name: entry.name,
    title: entry.name,
    classroomId: activeState.context.classroom?.id,
    workspaceIdentity: activeState.workspaceIdentity,
    copyrightConfirmed: input.copyrightConfirmed === true,
    files,
  };
  if (activeState.context.sessionId) body.sessionId = activeState.context.sessionId;
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_WORK_REQUEST_BYTES) {
    throw new Error("作品编码后太大，请减少素材后再提交。");
  }
  const suffix = activeState.context.sessionId ? `?sessionId=${encodeURIComponent(activeState.context.sessionId)}` : "";
  return callPlatform(`/api/student/runtime/submit-upload${suffix}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function callPlatform(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  return apiRequest(path, init, activeState.session.token);
}

export async function getLingdongPlatformSnapshot(): Promise<unknown> {
  if (!activeState) return null;
  return {
    user: activeState.session.user ?? null,
    classroom: activeState.context.classroom,
    models: activeState.context.models ?? [],
    defaultModel: activeState.context.defaultModel ?? null,
    presets: activeState.context.presets ?? [],
    workspacePath: activeState.workspacePath,
    workspaceIdentity: activeState.workspaceIdentity,
    classroomId: activeState.context.classroom?.id ?? null,
  };
}

function registerPlatformHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle("lingdong:platform-snapshot", () => getLingdongPlatformSnapshot());
  ipcMain.handle("lingdong:platform-works", () => callPlatform("/api/student/works?page=1&limit=20"));
  ipcMain.handle("lingdong:platform-scan-workspace", () => scanLingdongWorkspaceFiles());
  ipcMain.handle("lingdong:platform-submit-work", (_event, payload: unknown) => submitWorkFromDesktop(payload));
  ipcMain.handle("lingdong:platform-refresh-context", async () => {
    if (!activeState) return null;
    const context = unwrap<LingdongContext>(await callPlatform("/api/student/runtime/client-context"));
    activeState = { ...activeState, context };
    return getLingdongPlatformSnapshot();
  });
}

function gateHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>灵动ai</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#15171c;color:#f5f7fb;font:14px system-ui,"Microsoft YaHei",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{width:390px;padding:30px;border:1px solid #343943;border-radius:18px;background:#20232a;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;font-size:26px}p{color:#aab1bf;line-height:1.6;margin:8px 0 20px}.field{display:block;margin:14px 0}.field span{display:block;margin-bottom:7px;color:#cdd3df}.field input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #444b58;background:#17191f;color:#fff;font:inherit;outline:none}.field input:focus{border-color:#6d8cff}.submit{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#5575f4;color:#fff;font:inherit;font-weight:600;cursor:pointer}.submit:disabled{opacity:.6;cursor:wait}.status{min-height:22px;margin-top:14px;color:#ffb5b5;white-space:pre-wrap}.small{font-size:12px;color:#858e9e;margin-top:18px}</style></head><body><main class="card"><h1>灵动ai</h1><p>请登录平台账号，进入当前课堂后开始使用 ZCode。</p><form id="form"><label class="field"><span>账号</span><input id="login" autocomplete="username" required></label><label class="field"><span>密码</span><input id="password" type="password" autocomplete="current-password" required></label><button class="submit" id="submit">登录并进入课堂</button><div class="status" id="status"></div><div id="choices"></div></form><div class="small">模型请求统一经过灵动ai平台网关。</div><script>const form=document.getElementById('form'),status=document.getElementById('status'),button=document.getElementById('submit'),choices=document.getElementById('choices');function showChoices(items){choices.innerHTML='';(items||[]).forEach(item=>{const b=document.createElement('button');b.type='button';b.className='submit';b.style.marginTop='8px';b.textContent=(item.title||item.lessonTitle||item.id)+'（点击进入）';b.onclick=async()=>{button.disabled=true;status.textContent='正在进入课堂…';const r=await window.lingdongGate.login(document.getElementById('login').value,document.getElementById('password').value,item.id);if(!r.ok)status.textContent=r.message||'进入课堂失败';else status.textContent='课堂已就绪，正在启动…';button.disabled=false};choices.appendChild(b)})}form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;choices.innerHTML='';status.textContent='正在登录…';try{const r=await window.lingdongGate.login(document.getElementById('login').value,document.getElementById('password').value);if(!r.ok){status.textContent=r.message||'登录失败';if(r.classrooms)showChoices(r.classrooms)}else status.textContent='课堂已就绪，正在启动…'}catch(e){status.textContent=String(e)}finally{button.disabled=false}});</script></main></body></html>`;
}

export async function runLingdongPlatformGate(): Promise<LingdongPlatformState> {
  registerPlatformHandlers();
  if (activeState) return activeState;
  return await new Promise<LingdongPlatformState>((resolve, reject) => {
    const onLogin = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
      const result = await handleLogin(payload);
      if (result.ok && activeState) resolve(activeState);
      return result;
    };
    ipcMain.handle("lingdong:gate-login", onLogin);
    gateWindow = new BrowserWindow({
      width: 460,
      height: 650,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: "灵动ai",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(import.meta.dirname, "../preload/lingdongGate.cjs"),
      },
    });
    gateWindow.once("ready-to-show", () => gateWindow?.show());
    gateWindow.on("closed", () => {
      gateWindow = null;
      if (!activeState) reject(new Error("登录窗口已关闭。"));
      ipcMain.removeHandler("lingdong:gate-login");
    });
    void gateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(gateHtml())}`);
  });
}

export function getLingdongPlatformState(): LingdongPlatformState | null {
  return activeState;
}

export async function disposeLingdongPlatformGate(): Promise<void> {
  if (providerConfigPath) await rm(providerConfigPath, { force: true }).catch(() => undefined);
  providerConfigPath = null;
  activeState = null;
}
