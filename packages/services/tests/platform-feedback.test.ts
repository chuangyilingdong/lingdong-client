import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@zcode/shared";
import { createPlatformFeedbackService } from "../src/feedback/platformFeedbackService.js";

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ticket = {
  id: "cfb_test",
  title: "Windows 反馈测试",
  type: "bug" as const,
  severity: "P2-中" as const,
  module: "UI布局 / 交互" as const,
  status: "已提交" as const,
  raw_status: "SUBMITTED",
  reporter_display: "测试学生",
  created_at: "2026-11-02T01:00:00.000Z",
  updated_at: "2026-11-02T01:00:00.000Z",
  description: "侧栏没有预览",
  device: { osPlatform: "win32", osArch: "x64", appVersion: "0.2.12" },
  attachments: [],
  comments: [],
  events: [],
};

test("灵动ai 平台反馈 create 使用平台 token、device_mid 和操作幂等键", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const apiClient: ApiClient = {
    request: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(ticket);
    },
  };
  const service = createPlatformFeedbackService({
    apiBaseUrl: "https://aicyld.com/",
    authToken: "platform-token",
    getDeviceMid: () => "device-mid-1",
    apiClient,
  });
  const created = await service.create(
    {
      title: ticket.title,
      description: ticket.description,
      type: "bug",
      severity: "P2-中",
      module: "UI布局 / 交互",
      device: { osPlatform: "win32", osArch: "x64", appVersion: "0.2.12" },
      locale: "zh-CN",
    },
    { operationId: "operation-1" },
  );

  assert.equal(capturedUrl, "https://aicyld.com/api/client-feedback");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer platform-token");
  assert.equal(headers["X-Device-Mid"], "device-mid-1");
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.idempotencyKey, "operation-1");
  assert.deepEqual(body.environment, {
    osPlatform: "win32",
    osArch: "x64",
    appVersion: "0.2.12",
    source: "desktop-app",
    locale: "zh-CN",
  });
  assert.equal(created.id, "cfb_test");
  assert.equal(created.status, "已提交");
});

test("灵动ai 平台反馈 list 与 attachment upload 映射为客户端协议", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "platform-feedback-test-"));
  tempDirs.push(tempDir);
  const filePath = join(tempDir, "diagnostics.zip");
  await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const apiClient: ApiClient = {
    request: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/attachments?kind=log")) {
        return jsonResponse({
          id: "cfbatt_123",
          kind: "log",
          filename: "diagnostics.zip",
          size: 4,
          content_type: "application/zip",
          download_url: "/api/client-feedback/cfb_test/attachments/cfbatt_123/download",
          created_at: "2026-11-02T01:01:00.000Z",
        });
      }
      return jsonResponse({ items: [ticket], total: 1 });
    },
  };
  const service = createPlatformFeedbackService({
    apiBaseUrl: "https://aicyld.com",
    authToken: "platform-token",
    getDeviceMid: () => "device-mid-1",
    apiClient,
  });
  const listed = await service.list({ mine: true, limit: 20 });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]?.id, "cfb_test");
  assert.equal(listed.items[0]?.status, "已提交");

  const attached = await service.uploadAttachment("cfb_test", "log", {
    path: filePath,
    filename: "diagnostics.zip",
    contentType: "application/zip",
  });
  assert.equal(attached.filename, "diagnostics.zip");
  assert.equal(attached.kind, "log");
  assert.ok(attached.id > 0);
  const uploadRequest = requests.find((request) => request.url.includes("/attachments?kind=log"));
  assert.ok(uploadRequest);
  assert.ok(uploadRequest.init?.body instanceof FormData);
});
