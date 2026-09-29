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
for (const item of CLASSROOMS) {
  await mkdir(item.workspace, { recursive: true });
  await writeFile(
    join(item.workspace, "index.html"),
    `<!doctype html><html><body><h1>Mock ${item.id}</h1></body></html>`,
  );
  await writeFile(join(item.workspace, "notes.txt"), `MOCK_CLASSROOM_FILE ${item.id}\n`);
}
// 多课堂模式：登录后先返回课堂列表，由客户端选择再进课堂。
let multiClassroomMode = false;
// 最近一次 client-context 选中的课堂，供工具回合解析工作区内文件。
let activeClassroom = CLASSROOMS[0];
const requests = [];
const works = [];
let used = 0;
let quotaLimit = 10;
// 更新联动测试注入：manifest 指向的安装包字节由 /__test/update 提供。
let updateState = null;
let updateBytes = null;
const updateDownloads = [];
let revision = 1;
let mode = "text";
let toolRound = 0;
const origin = "http://127.0.0.1:19090";
const fakeKey = "mock-runtime-key";
const classroom = { id: "classroom-e2e", lessonId: "lesson-e2e", title: "联调测试课堂" };
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}
function context(sessionId) {
  const selected =
    CLASSROOMS.find((item) => item.id === sessionId) ??
    (multiClassroomMode ? null : CLASSROOMS[0]);
  if (!selected) {
    // 多课堂且未选择：只给列表，客户端必须让用户选一个课堂。
    return {
      classroom: null,
      classrooms: CLASSROOMS.map(({ id, lessonId, title }) => ({ id, lessonId, title })),
      message: "请选择要进入的课堂。",
    };
  }
  activeClassroom = selected;
  return {
    classroom: { id: selected.id, lessonId: selected.lessonId, title: selected.title },
    gateway: { baseUrl: `${origin}/gateway/v1`, key: fakeKey },
    models: [{ id: "mock-model", displayName: "Mock Model" }],
    defaultModel: "mock-model",
    presets: [{ title: "读取课堂文件", text: "读取 notes.txt 并总结内容" }],
    sends: {
      limit: quotaLimit,
      used,
      remaining: quotaLimit === null ? null : Math.max(0, quotaLimit - used),
    },
    workspacePath: selected.workspace,
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === "/__test/classrooms" && req.method === "POST") {
      const data = await body(req);
      multiClassroomMode = data.mode === "multiple";
      return json(res, 200, {
        multiClassroomMode,
        classrooms: CLASSROOMS.map(({ id, title }) => ({ id, title })),
      });
    }
    if (pathname === "/__test/mode" && req.method === "POST") {
      const data = await body(req);
      mode = data.mode;
      toolRound = 0;
      return json(res, 200, { mode });
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
        works,
        used,
        revision,
        updateDownloads,
        activeClassroomId: activeClassroom.id,
        multiClassroomMode,
      });
    if (pathname === "/api/auth/login" && req.method === "POST") {
      await body(req);
      return json(res, 200, {
        token: "mock-session-token",
        user: { id: "e2e-student", login: "mock", displayName: "联调学生" },
      });
    }
    if (pathname === "/api/student/runtime/client-context") {
      const sessionId = new URL(req.url, origin).searchParams.get("sessionId");
      return json(res, 200, context(sessionId));
    }
    if (pathname === "/api/auth/logout") return json(res, 200, { ok: true });
    if (pathname === "/api/student/works")
      return json(res, 200, { items: works, total: works.length });
    if (pathname === "/api/student/runtime/submit-upload" && req.method === "POST") {
      const data = await body(req);
      if (!data.copyrightConfirmed) return json(res, 400, { message: "缺少版权确认" });
      works.push({
        id: "work-" + (works.length + 1),
        name: data.name,
        files: data.files?.map((f) => f.name),
        cover: !!data.cover,
      });
      return json(res, 200, { ok: true, works: [works.at(-1)], warnings: [], missing: [] });
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
          prompt_tokens: 120,
          completion_tokens: 12,
          total_tokens: 132,
          prompt_tokens_details: { cached_tokens: 80 },
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
        res.writeHead(200, { "content-type": "text/event-stream" });
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
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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
      } else return json(res, 200, completion);
      return;
    }
    json(res, 404, { message: "mock route not found", path: pathname });
  } catch (e) {
    json(res, 500, { message: String(e) });
  }
});
server.listen(19090, "127.0.0.1", () => console.log("WINDOWS_PLATFORM_MOCK_READY 19090"));

