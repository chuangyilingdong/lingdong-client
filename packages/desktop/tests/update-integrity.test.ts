import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyUpdateArtifactIntegrity } from "../src/main/updateIntegrity.js";

async function withArtifact(
  content: Buffer,
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-update-integrity-"));
  const filePath = join(directory, "installer.exe");
  try {
    await writeFile(filePath, content);
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("安装前 SHA-256 一致时允许继续", async () => {
  const content = Buffer.from("verified update artifact", "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  await withArtifact(content, async (filePath) => {
    await verifyUpdateArtifactIntegrity({ filePath, sha256 });
  });
});

test("安装前 SHA-256 不一致时拒绝启动安装器", async () => {
  const content = Buffer.from("damaged update artifact", "utf8");
  await withArtifact(content, async (filePath) => {
    await assert.rejects(
      verifyUpdateArtifactIntegrity({ filePath, sha256: "0".repeat(64) }),
      /SHA-256 mismatch/u,
    );
  });
});

test("缺少可用校验值时 fail-closed", async () => {
  const content = Buffer.from("unchecked update artifact", "utf8");
  await withArtifact(content, async (filePath) => {
    await assert.rejects(verifyUpdateArtifactIntegrity({ filePath }), /no supported checksum/u);
  });
});

test("安装前 SHA-512 一致时允许继续", async () => {
  const content = Buffer.from("sha512 verified update artifact", "utf8");
  const sha512 = createHash("sha512").update(content).digest("base64");
  await withArtifact(content, async (filePath) => {
    await verifyUpdateArtifactIntegrity({ filePath, sha512 });
  });
});
