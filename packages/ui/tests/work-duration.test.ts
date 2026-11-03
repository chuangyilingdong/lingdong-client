import assert from "node:assert/strict";
import test from "node:test";
import { formatRunningWorkDuration } from "../src/lib/workDuration.js";

const labels = {
  "chat.history.duration.hour": "小时",
  "chat.history.duration.minute": "分",
  "chat.history.duration.second": "秒",
};
const formatMessage = ({ id }: { id: string }) => labels[id] ?? id;

test("运行中时长保留十分之一秒", () => {
  assert.equal(formatRunningWorkDuration(88_700, formatMessage, "zh-CN"), "1 分 28.7 秒");
  assert.equal(formatRunningWorkDuration(9_040, formatMessage, "zh-CN"), "9.0 秒");
});

test("运行中时长先舍入到十分之一秒，跨分钟不出现 60.0 秒", () => {
  assert.equal(formatRunningWorkDuration(59_960, formatMessage, "zh-CN"), "1 分 0.0 秒");
});
