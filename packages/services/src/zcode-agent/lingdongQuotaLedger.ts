import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

export type QuotaOutcome = "accepted" | "duplicate" | "rejected" | "uncertain";
export interface QuotaSnapshot {
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
}
interface QuotaFile {
  readonly version: 1;
  limit: number | null;
  used: number;
  entries: Record<string, "pending" | "accepted">;
}
const empty = (): QuotaFile => ({ version: 1, limit: null, used: 0, entries: {} });
export function normalizeSendLimit(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
function snapshot(file: QuotaFile): QuotaSnapshot {
  return {
    limit: file.limit,
    used: file.used,
    remaining: file.limit === null ? null : Math.max(0, file.limit - file.used),
  };
}
async function load(path: string): Promise<QuotaFile> {
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as QuotaFile;
    if (
      file.version !== 1 ||
      !Number.isInteger(file.used) ||
      file.used < 0 ||
      !file.entries ||
      typeof file.entries !== "object"
    )
      throw Error("课堂额度投影文件无效");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
}
export function createLingdongQuotaLedger(path: string) {
  async function update<T>(
    mutate: (file: QuotaFile) => { result: T; changed: boolean },
  ): Promise<T> {
    return withFileLock(path, async () => {
      const file = await load(path);
      const { result, changed } = mutate(file);
      if (changed) await atomicWritePrivateTextFile(path, JSON.stringify(file));
      return result;
    });
  }
  return {
    async read(): Promise<QuotaSnapshot> {
      return snapshot(await load(path));
    },
    async sync(
      sends: { readonly limit?: unknown; readonly used?: unknown },
      reset = false,
    ): Promise<QuotaSnapshot> {
      return update((file) => {
        const used = Number(sends.used);
        file.limit = normalizeSendLimit(sends.limit);
        if (reset) {
          file.entries = {};
          file.used = Number.isInteger(used) && used >= 0 ? used : 0;
        } else if (Number.isInteger(used) && used > file.used) file.used = used;
        return { result: snapshot(file), changed: true };
      });
    },
    async reserve(id: string): Promise<{ readonly id: string; readonly fresh: boolean }> {
      if (!id.trim()) throw Error("课堂发送命令缺少幂等键");
      return update<{ readonly id: string; readonly fresh: boolean }>((file) => {
        if (file.entries[id]) return { result: { id, fresh: false }, changed: false };
        if (file.limit !== null && file.used >= file.limit)
          throw Object.assign(new Error("本节课发送次数已用完"), { code: "SEND_QUOTA_EXCEEDED" });
        file.entries[id] = "pending";
        file.used++;
        return { result: { id, fresh: true }, changed: true };
      });
    },
    async settle(
      slot: { readonly id: string; readonly fresh: boolean },
      outcome: QuotaOutcome,
    ): Promise<void> {
      if (!slot.fresh) return;
      await update((file) => {
        if (file.entries[slot.id] !== "pending") return { result: undefined, changed: false };
        if (outcome === "rejected" || outcome === "duplicate") {
          delete file.entries[slot.id];
          file.used = Math.max(0, file.used - 1);
        } else file.entries[slot.id] = outcome === "accepted" ? "accepted" : "pending";
        return { result: undefined, changed: true };
      });
    },
  };
}
