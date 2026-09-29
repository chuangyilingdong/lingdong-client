import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createLingdongQuotaLedger } from "../src/zcode-agent/lingdongQuotaLedger.js";
const dirs: string[] = [];
async function ledger(limit: unknown, used = 0) {
  const dir = await mkdtemp(join(tmpdir(), "lingdong-quota-test-"));
  dirs.push(dir);
  const file = join(dir, "quota.json");
  const q = createLingdongQuotaLedger(file);
  await q.sync({ limit, used }, true);
  return { q, file };
}
after(async () => {
  for (const dir of dirs) {
    const rel = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
    await rm(dir, { recursive: true, force: true });
  }
});

test("不限次数的各种写法都不拦截（含平台口径的 0）", async () => {
  // 平台确认：sends.limit 只下发 null 或正整数，且后台"不填或填 0"都表示不限次。
  for (const value of [undefined, null, "", " ", "bad", -1, 0, "0"]) {
    const { q } = await ledger(value);
    const slot = await q.reserve("input-a");
    assert.ok(slot.fresh);
    assert.equal((await q.read()).limit, null, `limit=${String(value)} 应视为不限`);
  }
});
test("正整数上限才会拦截，remaining 归零即用尽", async () => {
  const { q } = await ledger(1);
  await q.settle(await q.reserve("input-a"), "accepted");
  assert.deepEqual(await q.read(), { limit: 1, used: 1, remaining: 0 });
  await assert.rejects(
    q.reserve("input-b"),
    (e) => (e as { code?: string }).code === "SEND_QUOTA_EXCEEDED",
  );
});
test("同命令重放只占一次，明确拒绝释放新预留", async () => {
  const { q } = await ledger(1);
  const first = await q.reserve("input-a");
  const duplicate = await q.reserve("input-a");
  assert.equal(duplicate.fresh, false);
  await q.settle(first, "accepted");
  assert.equal((await q.read()).used, 1);
  await assert.rejects(q.reserve("input-b"));
  const { q: q2 } = await ledger(1);
  const rejected = await q2.reserve("rejected");
  await q2.settle(rejected, "rejected");
  assert.equal((await q2.read()).used, 0);
  await q2.reserve("valid");
});
test("来自另一个 CLI 已接受的 duplicate 不再占用新增额度", async () => {
  const { q } = await ledger(2, 1);
  const fresh = await q.reserve("already-admitted");
  await q.settle(fresh, "duplicate");
  assert.equal((await q.read()).used, 1);
});
test("ACK 不确定时保留预留，原 ID 重试不重复计数", async () => {
  const { q } = await ledger(1);
  const first = await q.reserve("input-a");
  await q.settle(first, "uncertain");
  assert.equal((await q.reserve("input-a")).fresh, false);
  assert.equal((await q.read()).used, 1);
});
test("两个 Host 投影实例并发，只能争得最后一次额度", async () => {
  const { q, file } = await ledger(1);
  const other = createLingdongQuotaLedger(file);
  const outcomes = await Promise.allSettled([q.reserve("window-a"), other.reserve("window-b")]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await q.read()).used, 1);
});
test("平台同步不因旧 used 降低本机投影，额度提升即时生效", async () => {
  const { q } = await ledger(1);
  await q.settle(await q.reserve("input-a"), "accepted");
  await q.sync({ limit: 3, used: 0 });
  assert.deepEqual(await q.read(), { limit: 3, used: 1, remaining: 2 });
  await q.sync({ limit: 3, used: 2 });
  assert.equal((await q.read()).used, 2);
  await q.reserve("input-b");
});
