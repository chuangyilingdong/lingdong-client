/* oxlint-disable eslint(max-lines) -- mock 平台在单文件里复刻生产契约，拆开会让各场景响应形状漂移。 */
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(".tmp/windows-platform-e2e");

/** 每个课堂有独立工作区，用于验证课堂隔离（工作区 + 额度桶都不能串）。 */
const CLASSROOMS = [
  {
    id: "classroom-e2e",
    lessonId: "lesson-e2e",
    title: "联调测试课堂",
    workspace: join(root, "classroom"),
  },
  {
    id: "classroom-e2e-b",
    lessonId: "lesson-e2e-b",
    title: "联调测试课堂 B",
    workspace: join(root, "classroom-b"),
  },
];
// 1x1 PNG：用来验证「入口 HTML 引用的本地素材要一起提交」。
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
for (const item of CLASSROOMS) {
  await mkdir(join(item.workspace, "assets"), { recursive: true });
  await writeFile(join(item.workspace, "assets", "hero.png"), TINY_PNG);
  await writeFile(join(item.workspace, "assets", "bg.png"), TINY_PNG);
  await writeFile(join(item.workspace, "assets", "clip.mp4"), Buffer.from("MOCK_MP4_BYTES"));
  await writeFile(
    join(item.workspace, "style.css"),
    `body{background:url("assets/bg.png") no-repeat}\n`,
  );
  // 入口 HTML：三条本地引用（css / img / video）必须在清单里；三条外部/无效引用必须在清单外。
  // ⚠️ 过滤样本放进 HTML 注释：客户端扫的是原始文本（照样能覆盖过滤规则），
  //    但浏览器不会去加载它们——否则封面截图窗口会卡在外网请求上直到超时。
  const html = [
    "<!doctype html><html><head>",
    "<link rel='stylesheet' href='style.css'>",
    "</head><body>",
    `<h1>Mock ${item.id}</h1>`,
    "<img src='assets/hero.png' alt='hero'>",
    "<video src='assets/clip.mp4'></video>",
    "<!--",
    "<img src='https://example.com/remote.png'>",
    "<img src='data:image/png;base64,AAAA'>",
    "<a href='#top'>top</a>",
    "-->",
    "</body></html>",
  ].join("");
  await writeFile(join(item.workspace, "index.html"), html);
  await writeFile(join(item.workspace, "notes.txt"), `MOCK_CLASSROOM_FILE ${item.id}\n`);
}
// 课堂可用性形态（对齐平台契约）：
//   active = 有正在进行的 VibeCoding 课堂（正常情形，最多 1 个）
//   none   = 老师还没开始上课
//   canvas = 当前是画布课堂（服务端明确拒绝下发密钥）
let classroomMode = "active";
// 进行中的课堂数量：2 用于模拟"绕过校验的历史脏数据"，客户端不得让学生选。
let activeClassroomCount = 1;
// 最近一次 client-context 选中的课堂，供工具回合解析工作区内文件。
let activeClassroom = CLASSROOMS[0];
// 老师端备课：记录客户端确实带了 prep=1&lessonId=… 来取上下文。
const prepContexts = [];
const requests = [];
const works = [];
let used = 0;
let quotaLimit = 10;
// 更新联动测试注入：manifest 指向的安装包字节由 /__test/update 提供。
let updateState = null;
let updateBytes = null;
const updateDownloads = [];
let revision = 1;
// 退出登录调用记录：E2E 用它证明客户端确实通知了平台注销 token。
const logoutCalls = [];
// 平台真实行为开关（默认与生产一致）：
//   omitWorkspacePath 平台不下发工作区（生产事实：学生本机工作区只有客户端知道）。
//     默认 false 是为了让多数 E2E 保持在本仓库 .tmp 下；生产分支由专门场景开启验证。
//   sessionSuperseded 账号在别处登录 → 401 SESSION_SUPERSEDED
//   submitIncludesWorks 提交响应直接带 works（新版，未发版前为 false）
// 网关 usage 可配；默认 90% 命中（客户端生产构建只在 >=78% 时展示命中率）。
let usageOverride = { prompt: 100, completion: 10, cached: 90 };
let omitWorkspacePath = false;
let sessionSuperseded = false;
let submitIncludesWorks = false;
let mode = "text";
let toolRound = 0;
// 平台网关历史截断标记（默认关闭 = 不截断）。
// 只发 x-platform-history-dropped：客户端不消费保留上限，这里也不发，避免测试掩盖该依赖。
let historyTruncation = { dropped: 0 };
const origin = "http://127.0.0.1:19090";
const fakeKey = "mock-runtime-key";
const classroom = { id: "classroom-e2e", lessonId: "lesson-e2e", title: "联调测试课堂" };
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
// 平台成功响应统一是 {success, ok, data}；错误体是 {error:{code,message}}。
const ok = (res, data) => json(res, 200, { success: true, ok: true, data });
const fail = (res, status, code, message) =>
  json(res, status, { error: { code, message } });
// 平台资源名白名单：≤6 段、单段 ≤64、整名 ≤120；段首中英文/数字，段内可含 . _ -；
// 禁 .. 与隐藏文件、绝对路径、盘符、反斜杠。
const WORK_ASSET_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
function isValidWorkAssetName(raw) {
  const name = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!name || name.length > 120) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  if (segments.length === 0 || segments.length > 6) return false;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.startsWith(".")) return false;
    if (segment.length > 64) return false;
    if (!WORK_ASSET_SEGMENT_PATTERN.test(segment)) return false;
  }
  return true;
}

async function body(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}
/**
 * 老师端「VibeCoding 备课」上下文（对齐平台生产响应）。
 * 特征：prep:true、classroom 恒 null、有 lesson/presets/models，**刻意不给 gateway/sends**——
 * 平台靠「不发运行密钥」兜底，客户端结构上就发不出生成请求。
 */
function prepContext(lessonId) {
  return {
    prep: true,
    classroom: null,
    classrooms: [],
    upcoming: null,
    reason: "TEACHER_PREP",
    message: "备课模式：可以走一遍学生的界面流程，但不能生成内容",
    user: { id: "e2e-teacher", name: "联调老师", role: "TEACHER" },
    lesson: {
      id: lessonId ?? "lesson-prep-e2e",
      title: "联调备课课时",
      seriesTitle: "联调备课课时",
      deliveryMode: "VIBECODING",
      deliveryModes: ["VIBECODING", "CANVAS"],
      capabilities: ["image", "music", "text", "video"],
    },
    presets: [{ title: "备课预设", text: "这是备课模式的预设提示词" }],
    models: [{ id: "mock-model", displayName: "Mock Model" }],
    defaultModel: "mock-model",
  };
}

function context(sessionId) {
  const publicOf = ({ id, lessonId, title }) => ({ id, lessonId, title });
  if (classroomMode === "none") {
    // 老师还没开始上课：给 upcoming 但不发密钥。
    return {
      classroom: null,
      classrooms: [],
      upcoming: {
        id: CLASSROOMS[0].id,
        lessonId: CLASSROOMS[0].lessonId,
        title: CLASSROOMS[0].title,
        seriesTitle: null,
        lessonTitle: CLASSROOMS[0].title,
        teacherName: "联调老师",
        startedAt: null,
      },
      reason: "NOT_STARTED",
      message: "老师还没有开始上课",
    };
  }
  if (classroomMode === "canvas") {
    // 画布课堂：只回 null 与一句话，不带 gateway/presets/sends。
    return {
      classroom: null,
      classrooms: [],
      upcoming: null,
      reason: "CLASSROOM_MODE_MISMATCH",
      message: "当前是画布课堂，请在学生端进入画布课堂",
    };
  }
  const available = CLASSROOMS.slice(0, activeClassroomCount);
  const selected = sessionId
    ? available.find((item) => item.id === sessionId) ?? null
    : available[0];
  if (!selected) {
    return {
      classroom: null,
      classrooms: available.map(publicOf),
      upcoming: null,
      reason: "CLASSROOM_NOT_AVAILABLE",
      message: "你选的那节课已经结束了",
    };
  }
  activeClassroom = selected;
  return {
    classroom: { id: selected.id, lessonId: selected.lessonId, title: selected.title },
    classrooms: available.map(publicOf),
    reason: null,
    gateway: { baseUrl: `${origin}/gateway/v1`, key: fakeKey },
    models: [{ id: "mock-model", displayName: "Mock Model" }],
    defaultModel: "mock-model",
    presets: [{ title: "读取课堂文件", text: "读取 notes.txt 并总结内容" }],
    sends: {
      limit: quotaLimit,
      used,
      remaining: quotaLimit === null ? null : Math.max(0, quotaLimit - used),
    },
    ...(omitWorkspacePath ? {} : { workspacePath: selected.workspace }),
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === "/__test/usage" && req.method === "POST") {
      const data = await body(req);
      usageOverride = {
        prompt: Number(data.prompt ?? usageOverride.prompt),
        completion: Number(data.completion ?? usageOverride.completion),
        cached: Number(data.cached ?? usageOverride.cached),
      };
      return json(res, 200, usageOverride);
    }
    if (pathname === "/__test/platform" && req.method === "POST") {
      const data = await body(req);
      if (typeof data.omitWorkspacePath === "boolean") omitWorkspacePath = data.omitWorkspacePath;
      if (typeof data.sessionSuperseded === "boolean") sessionSuperseded = data.sessionSuperseded;
      if (typeof data.submitIncludesWorks === "boolean") submitIncludesWorks = data.submitIncludesWorks;
      return json(res, 200, { omitWorkspacePath, sessionSuperseded, submitIncludesWorks });
    }
    if (pathname === "/__test/classrooms" && req.method === "POST") {
      const data = await body(req);
      classroomMode =
        data.mode === "none" || data.mode === "canvas" ? data.mode : "active";
      activeClassroomCount = data.count === 2 ? 2 : 1;
      return json(res, 200, {
        classroomMode,
        activeClassroomCount,
        classrooms: CLASSROOMS.slice(0, activeClassroomCount).map(({ id, title }) => ({ id, title })),
      });
    }
    if (pathname === "/__test/mode" && req.method === "POST") {
      const data = await body(req);
      mode = data.mode;
      toolRound = 0;
      return json(res, 200, { mode });
    }
    if (pathname === "/__test/history" && req.method === "POST") {
      const data = await body(req);
      historyTruncation = { dropped: Number(data.dropped ?? 0) };
      return json(res, 200, historyTruncation);
    }
    if (pathname === "/__test/quota" && req.method === "POST") {
      const data = await body(req);
      quotaLimit = data.limit;
      used = data.used ?? 0;
      return json(res, 200, { quotaLimit, used });
    }
    if (pathname === "/__test/update" && req.method === "POST") {
      const data = await body(req);
      updateState = data.manifest;
      updateBytes = data.bytes ? Buffer.from(data.bytes, "base64") : null;
      return json(res, 200, { ok: true, version: updateState?.version ?? null });
    }
    if (pathname === "/__test/state")
      return json(res, 200, {
        requests,
        prepContexts,
        works,
        used,
        revision,
        updateDownloads,
        logoutCalls,
        activeClassroomId: activeClassroom.id,
        classroomMode,
        activeClassroomCount,
      });
    if (pathname === "/api/auth/login" && req.method === "POST") {
      await body(req);
      return ok(res, {
        token: "mock-session-token",
        user: { id: "e2e-student", login: "mock", displayName: "联调学生" },
      });
    }
    if (pathname === "/api/student/runtime/client-context") {
      if (sessionSuperseded)
        return fail(res, 401, "SESSION_SUPERSEDED", "当前账号已在其他设备登录");
      const params = new URL(req.url, origin).searchParams;
      if (params.get("prep") === "1") {
        const lessonId = params.get("lessonId");
        prepContexts.push({ lessonId, at: Date.now() });
        return ok(res, prepContext(lessonId));
      }
      return ok(res, context(params.get("sessionId")));
    }
    if (pathname === "/api/auth/logout") {
      logoutCalls.push({ authorization: req.headers.authorization ?? null, at: Date.now() });
      return ok(res, { ok: true });
    }
    if (pathname === "/api/student/works") {
      // submitIncludesWorks 场景下故意让列表接口落后，用于区分客户端到底用了哪条数据。
      if (submitIncludesWorks) return ok(res, { items: [], total: 0 });
      return ok(res, { items: works, total: works.length });
    }
    if (pathname === "/api/student/runtime/submit-upload" && req.method === "POST") {
      const data = await body(req);
      if (!data.copyrightConfirmed)
        return fail(res, 400, "WORK_COPYRIGHT_CONFIRMATION_REQUIRED", "请先确认作品为本人原创");
      // 平台侧逐段校验资源名，不合规整单 400、不静默改名；mock 复刻这条规则，
      // 客户端一旦回退成「扁平文件名」或被素材引用带出非法名，E2E 会直接红。
      for (const file of data.files ?? []) {
        if (!isValidWorkAssetName(String(file?.name ?? ""))) {
          return fail(res, 400, "INVALID_WORK_ASSET_NAME", `作品文件名不合法：${file?.name}`);
        }
      }
      works.push({
        id: "work-" + (works.length + 1),
        name: data.name,
        entryFile: data.name,
        classSessionId: activeClassroom.id,
        source: "VIBECODING",
        submittedAt: new Date().toISOString(),
        files: data.files?.map((f) => ({ name: f.name, binary: !!f.binary })),
        cover: !!data.cover,
      });
      return ok(res, {
        ok: true,
        warnings: [],
        missing: [],
        // 新版平台：提交响应直接回 works（形状同 GET /student/works 条目）
        ...(submitIncludesWorks ? { works: [works.at(-1)] } : {}),
      });
    }
    if (pathname === "/downloads/manifest.json") {
      if (updateState) return json(res, 200, updateState);
      return json(res, 200, {
        version: "0.2.0-zcode.1",
        enabled: true,
        mandatory: false,
        minVersion: "",
        files: {
          "win-x64": {
            version: "0.2.0-zcode.1",
            name: "lingdong-client-0.2.0-zcode.1-win-x64.exe",
            size: 1,
            sha256: "a".repeat(64),
          },
        },
      });
    }
    // 安装包下载：只在更新测试注入字节后提供，其余情况 404 以便暴露路径错误。
    if (pathname.startsWith("/downloads/") && updateBytes) {
      const name = pathname.slice("/downloads/".length);
      if (updateState?.files?.["win-x64"]?.name !== name) {
        res.writeHead(404);
        res.end("update artifact name mismatch");
        return;
      }
      updateDownloads.push({ name, at: Date.now() });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(updateBytes.byteLength),
      });
      res.end(updateBytes);
      return;
    }
    if (pathname === "/gateway/v1/chat/completions" && req.method === "POST") {
      const data = await body(req);
      const keyMatches = req.headers.authorization === `Bearer ${fakeKey}`;
      requests.push({
        model: data.model,
        keyMatches,
        stream: data.stream,
        tools: data.tools?.map((t) => ({
          name: t.function?.name,
          parameters: t.function?.parameters,
        })),
        toolReplies: data.messages?.filter((m) => m.role === "tool").length ?? 0,
      });
      if (!keyMatches)
        return json(res, 401, {
          error: { message: "mock runtime key mismatch", code: "UNAUTHORIZED" },
        });
      const historyHeaders =
        historyTruncation.dropped > 0
          ? { "x-platform-history-dropped": String(historyTruncation.dropped) }
          : {};
      const completion = {
        id: "mock-completion",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "MOCK_GATEWAY_RESPONSE：课堂网关联通。" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: usageOverride.prompt,
          completion_tokens: usageOverride.completion,
          total_tokens: usageOverride.prompt + usageOverride.completion,
          prompt_tokens_details: { cached_tokens: usageOverride.cached },
          // 平台同时支持另一套命名；这里一并给出，用于验证客户端不会因字段名不同而丢缓存。
          prompt_cache_hit_tokens: usageOverride.cached,
          prompt_cache_miss_tokens: usageOverride.prompt - usageOverride.cached,
        },
      };
      if (mode === "tools" && data.stream && toolRound < 2) {
        toolRound++;
        const call = {
          index: 0,
          id: "mock-read-" + toolRound,
          type: "function",
          function: {
            name: "Read",
            arguments: JSON.stringify({
              file_path: join(activeClassroom.workspace, toolRound === 1 ? "notes.txt" : "index.html"),
            }),
          },
        };
        res.writeHead(200, { "content-type": "text/event-stream", ...historyHeaders });
        res.write(
          `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }], usage: undefined })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      if (mode === "tools" && data.stream)
        completion.choices[0].message.content = "MOCK_TWO_TOOL_ROUNDS_OK：两个文件已读取。";
      if (data.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...historyHeaders });
        for (const delta of [
          { role: "assistant" },
          { content: completion.choices[0].message.content },
        ])
          res.write(
            `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], usage: undefined })}\n\n`,
          );
        res.write(
          `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json", ...historyHeaders });
        res.end(JSON.stringify(completion));
      }
      return;
    }
    json(res, 404, { message: "mock route not found", path: pathname });
  } catch (e) {
    json(res, 500, { message: String(e) });
  }
});
server.listen(19090, "127.0.0.1", () => console.log("WINDOWS_PLATFORM_MOCK_READY 19090"));
