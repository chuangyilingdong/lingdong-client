import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("ApplyPatch is registered in the main built-in tool set", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/tool/handlers/index.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /import \{ applyPatchToolEntry \} from "\.\/apply-patch\.js";/);
  assert.match(source, /^\s{2}applyPatchToolEntry,$/m);
});