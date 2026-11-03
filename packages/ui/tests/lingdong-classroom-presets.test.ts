import assert from "node:assert/strict";
import test from "node:test";
import { lingdongPresetKey } from "../src/lib/lingdongPresets.js";

test("课堂预设 key 对同一项稳定，并区分重复内容", () => {
  const preset = { title: "读取课堂文件", text: "读取 notes.txt" };
  assert.equal(lingdongPresetKey(preset, 0), lingdongPresetKey({ ...preset }, 0));
  assert.notEqual(lingdongPresetKey(preset, 0), lingdongPresetKey(preset, 1));
});

test("课堂预设 key 对非字符串字段使用稳定回退", () => {
  assert.equal(
    lingdongPresetKey({ title: undefined, text: 42 }, 2),
    lingdongPresetKey({ title: undefined, text: 42 }, 2),
  );
});
