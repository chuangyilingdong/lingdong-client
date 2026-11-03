export type LingdongPresetLike = Readonly<{
  title?: unknown;
  text?: unknown;
}>;

/** 平台只下发标题和正文；重复项用序号区分，保证同一列表刷新后 key 稳定。 */
export function lingdongPresetKey(preset: LingdongPresetLike, index: number): string {
  const title = typeof preset.title === "string" ? preset.title.trim() : "";
  const text = typeof preset.text === "string" ? preset.text : "";
  return JSON.stringify([index, title, text]);
}
