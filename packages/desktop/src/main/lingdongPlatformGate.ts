/* eslint-disable max-lines -- 平台登录、课堂上下文、作品提交与封面采集共享 Main 单一所有者；迁移阶段保持边界收口。 */
import { app, BrowserWindow, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLingdongQuotaLedger, getAppConfigDir } from "@zcode/services/node";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME } from "@zcode/provider-node";
import { createLingdongProviderBinding } from "./lingdongProviderConfig.js";

type LingdongUser = {
  readonly id?: string;
  readonly displayName?: string;
  readonly login?: string;
};
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
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string };
  readonly models?: readonly { readonly id?: unknown; readonly displayName?: unknown }[];
  readonly defaultModel?: unknown;
  readonly presets?: readonly { readonly title?: unknown; readonly text?: unknown }[];
  readonly sends?: {
    readonly limit?: number | null;
    readonly used?: number;
    readonly remaining?: number | null;
  } | null;
  readonly workspacePath?: string;
  readonly message?: string;
  readonly prep?: unknown;
  readonly reason?: unknown;
  readonly lesson?: {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly seriesTitle?: unknown;
    readonly deliveryMode?: unknown;
  } | null;
};
type LingdongSession = { readonly token: string; readonly user?: LingdongUser };
export type LingdongPlatformState = Readonly<{
  session: LingdongSession;
  context: LingdongContext;
  providerConfigPath: string;
  workspacePath: string;
  workspaceIdentity: string;
  quotaFilePath: string;
}>;

const API_BASE = String(process.env.LINGDONG_API_BASE || "https://aicyld.com").replace(/\/+$/u, "");
let activeState: LingdongPlatformState | null = null;
let providerBinding: ReturnType<typeof createLingdongProviderBinding> | null = null;
let gateWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let platformGatePending = false;
// 老师端「VibeCoding 备课」深链带来的课时 id：登录/重新取上下文时用它走备课分支。
let pendingPrepLessonId: string | null = null;

/** 深链 `lingdong://open?prep=1&lesson=<id>` 的落点；null 表示回到学生路径。 */
export function setLingdongPrepLessonId(lessonId: string | null): void {
  pendingPrepLessonId =
    typeof lessonId === "string" && lessonId.trim() ? lessonId.trim() : null;
}

export function getLingdongPrepLessonId(): string | null {
  return pendingPrepLessonId;
}

function isPrepContext(context: LingdongContext): boolean {
  return context.prep === true;
}

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
  const lesson =
    String(classroom?.lessonTitle || classroom?.title || classroom?.id || "课堂")
      .trim()
      .replace(/[<>:"/\\|?*]+/gu, "-") || "课堂";
  return join(app.getPath("documents"), "灵动ai创作", `${display}-${lesson}`);
}

/** 备课工作区与任何一个学生课堂分开，避免老师的试做落到学生目录里。 */
function resolvePrepWorkspace(context: LingdongContext, user: LingdongUser | undefined): string {
  const display = String(user?.displayName || user?.login || "老师").trim() || "老师";
  const lesson =
    String(context.lesson?.title ?? "备课")
      .trim()
      .replace(/[<>:"/\\|?*]+/gu, "-") ||
    "备课";
  return join(app.getPath("documents"), "灵动ai创作", `${display}-备课-${lesson}`);
}

async function buildProviderConfig(context: LingdongContext, targetPath?: string): Promise<string> {
  const path = targetPath || join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  providerBinding ??= createLingdongProviderBinding(path);
  if (providerBinding.filePath !== path)
    throw new Error("课堂 Provider 配置根在会话中发生变化，请重新登录。");
  await providerBinding.apply(context);
  return path;
}

// 课堂额度投影按 workspace identity 隔离，同机多个 Window Host 共用一个带文件锁的文件。
function quotaFilePathForIdentity(identity: string): string {
  const key = createHash("sha256").update(identity).digest("hex");
  return join(getAppConfigDir(), "runtime", "lingdong-quota", `${key}.json`);
}

async function handleLogin(
  payload: unknown,
): Promise<
  | { ok: true; user?: LingdongUser; classroom: LingdongClassroom | null; workspacePath: string }
  | { ok: false; message: string }
> {
  try {
    const input = record<unknown>(payload) ? payload : {};
    const login = typeof input.login === "string" ? input.login.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!login || !password) return { ok: false, message: "请输入账号和密码。" };
    const rawSession = unwrap<Record<string, unknown>>(
      await apiRequest("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password }),
      }),
    );
    const token = String(rawSession.token || rawSession.accessToken || "").trim();
    if (!token) throw new Error("平台登录响应缺少 token。");
    const session: LingdongSession = {
      token,
      user: record<unknown>(rawSession.user) ? (rawSession.user as LingdongUser) : undefined,
    };
    // 老师端「VibeCoding 备课」用同一把 token 拿备课上下文：带 ?prep=1&lessonId=…
    // 平台按角色判，不带参数也会走备课分支；这里带参数只是让日志/缓存可对齐。
    const prepLessonId = pendingPrepLessonId;
    const contextPath = prepLessonId
      ? `/api/student/runtime/client-context?prep=1&lessonId=${encodeURIComponent(prepLessonId)}`
      : "/api/student/runtime/client-context";
    const context = unwrap<LingdongContext>(await apiRequest(contextPath, {}, session.token));
    // 备课上下文 classroom 恒为 null —— 那是正常形态，不能按「还没开课」拦下来。
    const prep = isPrepContext(context);
    if (!context.classroom && !prep)
      throw new Error(context.message || "当前没有正在进行的课堂。");
    const workspacePath = prep
      ? resolvePrepWorkspace(context, session.user)
      : resolveWorkspace(context, session.user);
    await mkdir(workspacePath, { recursive: true });
    const workspaceIdentity = prep
      ? `${session.user?.id || session.user?.login || login}:prep:${prepLessonId ?? String(context.lesson?.id ?? "")}`
      : `${session.user?.id || session.user?.login || login}:${context.classroom?.id}`;
    const quotaFilePath = quotaFilePathForIdentity(workspaceIdentity);
    if (!prep) {
      // 登录基线以平台 used 为准：换课堂换桶，同一课堂重新登录时对齐平台账目。
      await createLingdongQuotaLedger(quotaFilePath).sync(context.sends ?? {}, true);
    }
    // 备课上下文没有 gateway：不写 Provider 配置、不注入任何密钥（平台兜底，客户端不造）。
    const providerPath = prep ? "" : await buildProviderConfig(context);
    activeState = {
      session,
      context,
      providerConfigPath: providerPath,
      workspacePath,
      workspaceIdentity,
      quotaFilePath,
    };
    process.env.LINGDONG_API_BASE = API_BASE;
    process.env.PLATFORM_GATEWAY_KEY = prep ? "" : String(context.gateway?.key || "");
    process.env.PLATFORM_GATEWAY_BASE_URL = prep ? "" : String(context.gateway?.baseUrl || "");
    process.env.ZCODE_LINGDONG_WORKSPACE_PATH = workspacePath;
    process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY = activeState.workspaceIdentity;
    process.env.ZCODE_LINGDONG_CLASSROOM_ID = context.classroom?.id ?? "";
    process.env.ZCODE_LINGDONG_QUOTA_FILE = prep ? "" : quotaFilePath;
    // 登录成功后关闭登录窗，但 platformGatePending 会一直保持到主窗口就绪：
    // 应用进入"零窗口"瞬间时 window-all-closed 会被 pending 拦住，不会误退出。
    gateWindow?.close();
    return { ok: true, user: session.user, classroom: context.classroom, workspacePath };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function scanLingdongWorkspaceFiles(): Promise<unknown> {
  if (!activeState) return { ok: false, message: "平台登录尚未完成。", files: [] };
  const root = activeState.workspacePath;
  // 与作品提交白名单共用一份：以前这里只列图片和文档，
  // 视频/音频/CSS/JS 在提交对话框里根本看不到（学生以为客户端「识别不到视频」）。
  const allowed = WORK_ALLOWED_EXTENSIONS;
  const files: Array<{ path: string; relativePath: string; size: number; updatedAt: number }> = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length && files.length < 500) {
    const current = queue.shift();
    if (!current || current.depth > 5) continue;
    let entries: Awaited<ReturnType<typeof readdir>> = [];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
        continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        queue.push({ path, depth: current.depth + 1 });
        continue;
      }
      const extension = entry.name.includes(".")
        ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()
        : "";
      if (!allowed.has(extension)) continue;
      try {
        const info = await stat(path);
        files.push({
          path,
          relativePath: path
            .slice(root.length)
            .replace(/^[\\/]+/u, "")
            .replaceAll("\\", "/"),
          size: info.size,
          updatedAt: info.mtimeMs,
        });
      } catch {
        /* ignore disappearing files */
      }
      if (files.length >= 500) break;
    }
  }
  files.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ok: true, files, workspacePath: root, workspaceIdentity: activeState.workspaceIdentity };
}

type SubmitItem = Readonly<{ path?: unknown; relativePath?: unknown; name?: unknown }>;
type WorkFilePayload = Readonly<{ name: string; content: string; binary: boolean }>;
const WORK_TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".cjs",
  ".svg",
  ".text",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml",
]);
const WORK_ALLOWED_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".css",
  ".docx",
  ".xlsx",
  ".pptx",
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".mov",
  ".pdf",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".lua",
  ".rb",
  ".php",
  ".sql",
  ".zip",
]);
const MAX_WORK_FILES = 60;
// 整单上限跟平台对齐：平台侧是 RUNTIME_UPLOAD_MAX_BYTES（生产 100MB）。
// 16MB 是旧值——那时一节带视频的作品根本交不上去（视频被静默跳过）。
const MAX_WORK_TOTAL_BYTES = 100 * 1024 * 1024;
// base64 会把 100MB 撑到约 133MB；留出余量，但仍远低于平台 201MB 的 body 上限。
const MAX_WORK_REQUEST_BYTES = 140 * 1024 * 1024;
const COVER_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);
const COVER_TIMEOUT_MS = 12_000;
const SUBMITTABLE_ENTRY_EXTENSIONS = new Set([".htm", ".html", ".docx", ".xlsx", ".pptx"]);
const HTML_ENTRY_EXTENSIONS = new Set([".htm", ".html"]);
/**
 * 平台侧资源名白名单（服务端逐段校验，不合规整单 400、不静默改名）：
 * ≤6 段（5 层目录）、单段 ≤64 字、整名 ≤120 字；段首必须是中英文/数字，段内可含 . _ -；
 * 禁止 `..`、隐藏文件、绝对路径、盘符与反斜杠。
 */
const WORK_ASSET_NAME_MAX_SEGMENTS = 6;
const WORK_ASSET_NAME_MAX_SEGMENT_CHARS = 64;
const WORK_ASSET_NAME_MAX_CHARS = 120;
const WORK_ASSET_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * 入口文件名的兜底：学生起名很随意（`My Pokedex.html` 这种带空格的极常见），
 * 而平台白名单不接受空格。入口是主产物，它**自己的文件名不参与相对引用解析**，
 * 所以这里把非法字符换成 `-` 后照常提交，而不是把学生拦在门外。
 */
function sanitizeWorkEntryName(name: string): string | null {
  const replaced = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-._]+/u, "");
  return normalizeWorkAssetName(replaced);
}

/** 规整成一个通过平台白名单的相对路径名；不合法返回 null。 */
function normalizeWorkAssetName(raw: string): string | null {
  const unified = raw.trim().replaceAll("\\", "/");
  if (!unified) return null;
  if (unified.startsWith("/") || /^[A-Za-z]:/u.test(unified)) return null;
  const segments = unified.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.length > WORK_ASSET_NAME_MAX_SEGMENTS) return null;
  for (const segment of segments) {
    if (segment === ".." || segment.startsWith(".")) return null;
    if (segment.length > WORK_ASSET_NAME_MAX_SEGMENT_CHARS) return null;
    if (!WORK_ASSET_SEGMENT_PATTERN.test(segment)) return null;
  }
  const name = segments.join("/");
  return name.length <= WORK_ASSET_NAME_MAX_CHARS ? name : null;
}

// 入口 HTML / CSS 里的本地引用：HTML 属性（src|href|poster）与 CSS url()。
const HTML_LOCAL_REFERENCE_PATTERN =
  /\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/giu;
const CSS_URL_REFERENCE_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu;
const HTML_STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/giu;

function firstReferenceGroup(match: RegExpMatchArray): string | undefined {
  return match[1] ?? match[2] ?? match[3];
}

/**
 * 只保留「工作区内的相对引用」：丢掉 http(s)、//、data: 等协议、页内锚点与 `/` 开头的站点绝对路径，
 * 再去掉 ?query/#hash。返回的是逐字引用串，它同时是平台侧匹配用的 name。
 */
function normalizeLocalReference(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  let reference = value.trim();
  if (!reference) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)) return null;
  reference = reference.replace(/[?#].*$/u, "").trim();
  if (!reference || reference.startsWith("/")) return null;
  reference = reference.replace(/^\.\//u, "").trim();
  if (!reference || reference === "." || reference.startsWith("..")) return null;
  return reference;
}

function extractLocalReferences(content: string, kind: "html" | "css"): string[] {
  const references: string[] = [];
  const collect = (pattern: RegExp, text: string) => {
    for (const match of text.matchAll(pattern)) {
      const reference = normalizeLocalReference(firstReferenceGroup(match));
      if (reference) references.push(reference);
    }
  };
  if (kind === "css") {
    collect(CSS_URL_REFERENCE_PATTERN, content);
    return references;
  }
  collect(HTML_LOCAL_REFERENCE_PATTERN, content);
  for (const styleBlock of content.matchAll(HTML_STYLE_BLOCK_PATTERN)) {
    collect(CSS_URL_REFERENCE_PATTERN, styleBlock[1] ?? "");
  }
  return references;
}

/** 素材名按「入口文件所在目录」算，才能和 HTML 里写的相对引用逐字一致。 */
function toEntryRelativeName(entryDir: string, absolute: string): string | null {
  const relativeName = relative(entryDir, absolute);
  if (!relativeName || relativeName === "." || relativeName.startsWith("..") || isAbsolute(relativeName)) {
    return null;
  }
  return relativeName.replaceAll("\\", "/");
}

function pathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.includes(`..${sep}`));
}

async function prepareSubmitFiles(
  items: readonly SubmitItem[],
): Promise<{ readonly files: WorkFilePayload[]; readonly entryPath: string }> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  const root = await realpath(activeState.workspacePath);

  // 先解析勾选项并锁定入口文件：素材名要按「入口文件所在目录」计算，
  // 才能和 HTML 里写的相对引用逐字一致（平台按字面匹配后改写预览地址）。
  const candidates: Array<{ absolute: string; extension: string }> = [];
  const seenPaths = new Set<string>();
  for (const item of items.slice(0, MAX_WORK_FILES)) {
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!rawPath || !pathInside(root, rawPath)) continue;
    const absolute = await realpath(rawPath).catch(() => "");
    if (!absolute || !pathInside(root, absolute) || seenPaths.has(absolute)) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) continue;
    seenPaths.add(absolute);
    candidates.push({ absolute, extension: extname(absolute).toLowerCase() });
  }
  if (candidates.length === 0) throw new Error("没有找到可以提交的作品文件。");

  const entryCandidate = candidates.find((candidate) =>
    SUBMITTABLE_ENTRY_EXTENSIONS.has(candidate.extension),
  );
  if (!entryCandidate) throw new Error("请选择一个 HTML、PPT、Word 或 Excel 作为主作品文件。");
  const entryDir = dirname(entryCandidate.absolute);
  const entryName = sanitizeWorkEntryName(basename(entryCandidate.absolute));
  if (!entryName) {
    throw new Error(
      `作品入口文件名无法提交：${basename(entryCandidate.absolute)}（请改成中英文或数字开头、不含空格的名字）`,
    );
  }

  const files: WorkFilePayload[] = [];
  const usedNames = new Set<string>();
  const includedPaths = new Set<string>();
  let totalBytes = 0;

  const addFile = async (absolute: string, relativeName: string): Promise<boolean> => {
    if (includedPaths.has(absolute) || files.length >= MAX_WORK_FILES) return false;
    const name = normalizeWorkAssetName(relativeName);
    if (!name || usedNames.has(name)) return false;
    const extension = extname(absolute).toLowerCase();
    if (!WORK_ALLOWED_EXTENSIONS.has(extension)) return false;
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) return false;
    if (info.size > MAX_WORK_TOTAL_BYTES || totalBytes + info.size > MAX_WORK_TOTAL_BYTES)
      return false;
    const bytes = await readFile(absolute);
    const binary = !WORK_TEXT_EXTENSIONS.has(extension);
    files.push({
      name,
      content: binary ? bytes.toString("base64") : bytes.toString("utf8"),
      binary,
    });
    usedNames.add(name);
    includedPaths.add(absolute);
    totalBytes += info.size;
    return true;
  };

  // 入口先落进 files，保证 files[0] 与顶层 name 指向主产物。
  await addFile(entryCandidate.absolute, entryName);
  for (const candidate of candidates) {
    if (candidate.absolute === entryCandidate.absolute) continue;
    const name =
      toEntryRelativeName(entryDir, candidate.absolute) ?? basename(candidate.absolute);
    await addFile(candidate.absolute, name);
  }

  // 入口 HTML 引用的本地素材一并带上：图片/视频/音频按二进制，css/js 仍按文本（平台会内联进预览）。
  if (HTML_ENTRY_EXTENSIONS.has(entryCandidate.extension)) {
    await collectReferencedWorkAssets({
      root,
      entryAbsolute: entryCandidate.absolute,
      entryDir,
      addFile,
    });
  }

  if (files.length === 0) throw new Error("没有找到可以提交的作品文件。");
  return { files, entryPath: entryCandidate.absolute };
}

/**
 * 从入口 HTML 出发，沿着 src/href/poster 与 CSS url() 收集工作区内的本地素材。
 * 引用串（去掉 ./、?query、#hash 之后）就是提交给平台的 name，
 * 平台据此把预览里的相对引用改写成它自己的文件地址。
 */
async function collectReferencedWorkAssets(input: {
  root: string;
  entryAbsolute: string;
  entryDir: string;
  addFile: (absolute: string, relativeName: string) => Promise<boolean>;
}): Promise<void> {
  const visited = new Set<string>();
  const pending: string[] = [input.entryAbsolute];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const extension = extname(current).toLowerCase();
    const kind = extension === ".css" ? "css" : HTML_ENTRY_EXTENSIONS.has(extension) ? "html" : null;
    if (!kind) continue;
    const content = await readFile(current, "utf8").catch(() => "");
    if (!content) continue;
    const currentDir = dirname(current);
    for (const reference of extractLocalReferences(content, kind)) {
      const target = resolve(currentDir, reference);
      if (!pathInside(input.root, target)) continue;
      const absolute = await realpath(target).catch(() => "");
      if (!absolute || !pathInside(input.root, absolute)) continue;
      const name = toEntryRelativeName(input.entryDir, absolute);
      if (!name) continue;
      await input.addFile(absolute, name);
      if (extname(absolute).toLowerCase() === ".css") pending.push(absolute);
    }
  }
}

function coverMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

async function captureHtmlCover(
  entryPath: string,
): Promise<{ readonly content: string } | undefined> {
  if (![".html", ".htm"].includes(extname(entryPath).toLowerCase())) return undefined;
  const root = await realpath(activeState?.workspacePath || "").catch(() => "");
  const entry = await realpath(entryPath).catch(() => "");
  if (!root || !entry || !pathInside(root, entry)) return undefined;
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
      const requested = resolve(root, `.${pathname}`);
      if (!pathInside(root, requested)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const file = await realpath(requested);
      if (!pathInside(root, file)) {
        response.writeHead(403);
        response.end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": coverMimeType(file), "cache-control": "no-store" });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      server.once("error", rejectReady);
      server.listen(0, "127.0.0.1", () => resolveReady());
    });
    const address = server.address();
    if (!address || typeof address === "string") return undefined;
    const relativeEntry = relative(root, entry)
      .split("\\")
      .join("/")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await Promise.race([
        window.loadURL(`http://127.0.0.1:${address.port}/${relativeEntry}`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("cover timeout")), COVER_TIMEOUT_MS),
        ),
      ]);
      await new Promise((resolveReady) => setTimeout(resolveReady, 450));
      let image = await window.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 });
      let png = image.toPNG();
      if (png.byteLength > COVER_MAX_BYTES)
        png = image.resize({ width: 1024, height: 576 }).toPNG();
      return png.byteLength <= COVER_MAX_BYTES ? { content: png.toString("base64") } : undefined;
    } finally {
      window.destroy();
    }
  } catch {
    return undefined;
  } finally {
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  }
}

async function submitWorkFromDesktop(payload: unknown): Promise<unknown> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  const input = record<unknown>(payload) ? payload : {};
  const rawItems = Array.isArray(input.items) ? (input.items as SubmitItem[]) : [];
  const prepared = await prepareSubmitFiles(rawItems);
  const files = prepared.files;
  const entry = files.find((file) =>
    SUBMITTABLE_ENTRY_EXTENSIONS.has(extname(file.name).toLowerCase()),
  );
  if (!entry || !prepared.entryPath)
    throw new Error("请选择一个 HTML、PPT、Word 或 Excel 作为主作品文件。");
  const body: Record<string, unknown> = {
    name: entry.name,
    title: entry.name,
    classroomId: activeState.context.classroom?.id,
    workspaceIdentity: activeState.workspaceIdentity,
    copyrightConfirmed: input.copyrightConfirmed === true,
    files,
  };
  const cover = await captureHtmlCover(prepared.entryPath);
  if (cover) body.cover = cover;
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_WORK_REQUEST_BYTES) {
    throw new Error("作品编码后太大，请减少素材后再提交。");
  }
  // 平台新版在提交响应里直接回 works（形状同 GET /student/works）；解包后交给 renderer。
  return unwrap<Record<string, unknown>>(
    await callPlatform("/api/student/runtime/submit-upload", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

async function callPlatform(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!activeState) throw new Error("平台登录尚未完成。");
  return apiRequest(path, init, activeState.session.token);
}

export async function getLingdongPlatformSnapshot(): Promise<unknown> {
  if (!activeState) return null;
  const prep = isPrepContext(activeState.context);
  // 备课模式没有课堂额度桶，也不该显示「本节课发送次数」。
  const quota = prep
    ? undefined
    : await createLingdongQuotaLedger(activeState.quotaFilePath).read();
  return {
    user: activeState.session.user ?? null,
    classroom: activeState.context.classroom,
    models: activeState.context.models ?? [],
    defaultModel: activeState.context.defaultModel ?? null,
    presets: activeState.context.presets ?? [],
    workspacePath: activeState.workspacePath,
    workspaceIdentity: activeState.workspaceIdentity,
    classroomId: activeState.context.classroom?.id ?? null,
    prep,
    lesson: prep
      ? {
          id: String(activeState.context.lesson?.id ?? pendingPrepLessonId ?? ""),
          title: String(activeState.context.lesson?.title ?? ""),
        }
      : null,
    quota,
  };
}

/**
 * 退出平台登录。
 *
 * 先通知平台注销 token（失败不阻塞——本地必须回到未登录态），再清理本地 Provider 条目。
 * 清理后整个 Host/session 上下文都已失效，"重启回到登录门"是最可靠的收口方式，
 * 也顺带保证共享电脑上不会残留上一个学生的会话。
 */
async function logoutFromPlatform(): Promise<void> {
  const state = activeState;
  if (state) {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" }, state.session.token);
    } catch (error) {
      console.warn("[lingdong-gate] 平台登出失败，仅清理本地登录态。", error);
    }
  }
  await disposeLingdongPlatformGate();
}

function registerPlatformHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle("lingdong:platform-snapshot", () => getLingdongPlatformSnapshot());
  ipcMain.handle("lingdong:platform-works", async () =>
    unwrap<Record<string, unknown>>(await callPlatform("/api/student/works?page=1&limit=20")),
  );
  ipcMain.handle("lingdong:platform-scan-workspace", () => scanLingdongWorkspaceFiles());
  ipcMain.handle("lingdong:platform-submit-work", (_event, payload: unknown) =>
    submitWorkFromDesktop(payload),
  );
  ipcMain.handle("lingdong:platform-logout", async () => {
    await logoutFromPlatform();
    app.relaunch();
    app.quit();
  });
  ipcMain.handle("lingdong:platform-refresh-context", async () => {
    if (!activeState) return null;
    const context = unwrap<LingdongContext>(
      await callPlatform("/api/student/runtime/client-context"),
    );
    await buildProviderConfig(context, activeState.providerConfigPath);
    // 刷新只把本机投影向平台已用量收敛，不因较旧响应降低已接受的计数。
    await createLingdongQuotaLedger(activeState.quotaFilePath).sync(context.sends ?? {});
    process.env.PLATFORM_GATEWAY_BASE_URL = String(context.gateway?.baseUrl || "");
    process.env.PLATFORM_GATEWAY_KEY = String(context.gateway?.key || "");
    activeState = { ...activeState, context };
    return getLingdongPlatformSnapshot();
  });
}

function gateHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>灵动ai</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#15171c;color:#f5f7fb;font:14px system-ui,"Microsoft YaHei",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{width:390px;padding:30px;border:1px solid #343943;border-radius:18px;background:#20232a;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;font-size:26px}p{color:#aab1bf;line-height:1.6;margin:8px 0 20px}.field{display:block;margin:14px 0}.field span{display:block;margin-bottom:7px;color:#cdd3df}.field input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #444b58;background:#17191f;color:#fff;font:inherit;outline:none}.field input:focus{border-color:#6d8cff}.submit{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#5575f4;color:#fff;font:inherit;font-weight:600;cursor:pointer}.submit:disabled{opacity:.6;cursor:wait}.status{min-height:22px;margin-top:14px;color:#ffb5b5;white-space:pre-wrap}.small{font-size:12px;color:#858e9e;margin-top:18px}</style></head><body><main class="card"><h1>灵动ai</h1><p>请登录平台账号，进入当前课堂后开始使用 ZCode。</p><form id="form"><label class="field"><span>账号</span><input id="login" autocomplete="username" required></label><label class="field"><span>密码</span><input id="password" type="password" autocomplete="current-password" required></label><button class="submit" id="submit">登录并进入课堂</button><div class="status" id="status"></div></form><div class="small">模型请求统一经过灵动ai平台网关。</div><script>const form=document.getElementById('form'),status=document.getElementById('status'),button=document.getElementById('submit');form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;status.textContent='正在登录…';try{const r=await window.lingdongGate.login(document.getElementById('login').value,document.getElementById('password').value);if(!r.ok)status.textContent=r.message||'登录失败';else status.textContent='课堂已就绪，正在启动…'}catch(e){status.textContent=String(e)}finally{button.disabled=false}});</script></main></body></html>`;
}

export function isLingdongPlatformGatePending(): boolean {
  return platformGatePending;
}

// 登录窗不是主界面：窗口协调器必须把它排除，
// 否则 ensurePrimaryWindow 会把它当成"已存在窗口"复用，主窗口永不创建。
export function isLingdongGateWindow(window: unknown): boolean {
  return gateWindow !== null && window === gateWindow;
}

export async function runLingdongPlatformGate(): Promise<LingdongPlatformState | null> {
  registerPlatformHandlers();
  platformGatePending = true;
  if (activeState) return activeState;
  // 用户直接关闭登录窗时 resolve(null) 表示取消启动；绝不 reject，
  // 否则 app.whenReady() 链上会出现无人处理的 Promise 拒绝。
  return await new Promise<LingdongPlatformState | null>((resolve) => {
    const onLogin = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
      const result = await handleLogin(payload);
      if (result.ok && activeState) resolve(activeState);
      return result;
    };
    ipcMain.handle("lingdong:gate-login", onLogin);
    gateWindow = new BrowserWindow({
      width: 960,
      height: 620,
      minWidth: 720,
      minHeight: 520,
      resizable: true,
      minimizable: false,
      maximizable: false,
      show: false,
      autoHideMenuBar: true,
      icon: app.isPackaged
        ? join(process.resourcesPath, "icon_lingdong.png")
        : join(app.getAppPath(), "build/icon_installer.png"),
      title: "灵动ai创作客户端",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(import.meta.dirname, "../preload/lingdongGate.cjs"),
      },
    });
    gateWindow.removeMenu();
    gateWindow.once("ready-to-show", () => gateWindow?.show());
    gateWindow.on("closed", () => {
      gateWindow = null;
      // 仅在取消登录时放下待启动标记；登录成功后到主窗口就绪之间的空窗期内
      // 必须继续保持，否则 Windows 的 window-all-closed 会提前退出应用。
      if (!activeState) {
        platformGatePending = false;
        resolve(null);
      }
      ipcMain.removeHandler("lingdong:gate-login");
    });
    const gateFile = join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      app.isPackaged ? "gate" : "resources/gate",
      "login.html",
    );
    // 品牌资源随包分发；资源异常时仍回退到内联登录页，不能让学生停在白屏。
    void gateWindow
      .loadFile(gateFile)
      .catch(() =>
        gateWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(gateHtml())}`),
      );
  });
}

export function getLingdongPlatformState(): LingdongPlatformState | null {
  return activeState;
}

// 主窗口就绪后收口登录门：此后 window-all-closed 才允许按常规逻辑退出应用。
export function finishLingdongPlatformGate(): void {
  platformGatePending = false;
  const window = gateWindow;
  gateWindow = null;
  if (window && !window.isDestroyed()) window.close();
}

export async function disposeLingdongPlatformGate(): Promise<void> {
  const binding = providerBinding;
  providerBinding = null;
  await binding?.dispose();
  activeState = null;
}
