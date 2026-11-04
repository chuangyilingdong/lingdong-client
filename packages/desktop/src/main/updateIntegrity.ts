import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export interface UpdateArtifactIntegrity {
  filePath: string;
  sha256?: string;
  sha512?: string;
}

function hashFile(filePath: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64") {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash(algorithm);
    hash.setEncoding(encoding);
    createReadStream(filePath)
      .on("error", reject)
      .on("end", () => {
        hash.end();
        resolve(hash.read() as string);
      })
      .pipe(hash);
  });
}

function normalizeSha256(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeSha512(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  // electron-updater 的 sha512 使用 base64；同时兼容外部调试工具常见的 hex 形式。
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) && normalized.length >= 64) {
    return normalized;
  }
  if (/^[a-fA-F0-9]{128}$/u.test(normalized)) {
    return normalized.toLowerCase();
  }
  return null;
}

/**
 * 安装器启动前的最后一道完整性校验。
 *
 * electron-updater 可能在下载阶段完成校验，但下载完成后进程仍可能被安全软件、磁盘错误或
 * 外部操作改写。必须在交给 NSIS 之前重新读取文件，否则损坏的安装器只会在 NSIS 自检时失败。
 */
export async function verifyUpdateArtifactIntegrity(
  artifact: UpdateArtifactIntegrity,
): Promise<void> {
  const filePath = artifact.filePath.trim();
  if (!filePath) {
    throw new Error("Update artifact path is missing");
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Update artifact is not a file: ${filePath}`);
  }

  const expectedSha256 = normalizeSha256(artifact.sha256);
  const expectedSha512 = normalizeSha512(artifact.sha512);
  if (artifact.sha256?.trim() && !expectedSha256) {
    throw new Error("Update artifact contains an invalid SHA-256 checksum");
  }
  if (artifact.sha512?.trim() && !expectedSha512) {
    throw new Error("Update artifact contains an invalid SHA-512 checksum");
  }
  if (!expectedSha256 && !expectedSha512) {
    throw new Error("Update artifact has no supported checksum");
  }

  if (expectedSha256) {
    const actualSha256 = await hashFile(filePath, "sha256", "hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Update artifact SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
  }

  if (expectedSha512) {
    const actualSha512 = await hashFile(filePath, "sha512", "base64");
    const expectedComparable = /^[a-f0-9]{128}$/iu.test(expectedSha512)
      ? Buffer.from(expectedSha512, "hex").toString("base64")
      : expectedSha512;
    if (actualSha512 !== expectedComparable) {
      throw new Error("Update artifact SHA-512 mismatch");
    }
  }
}
