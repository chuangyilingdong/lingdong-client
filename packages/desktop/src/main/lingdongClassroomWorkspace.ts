const INVALID_WINDOWS_SEGMENT_CHARS = new Set('<>:"/\\|?*');
const TRAILING_WINDOWS_SEGMENT_CHARS = /[. ]+$/u;

export function sanitizeLingdongWorkspaceSegment(value: unknown, fallback: string): string {
  const normalized = [...String(value ?? "").trim()]
    .map((character) =>
      character.charCodeAt(0) <= 0x1f || INVALID_WINDOWS_SEGMENT_CHARS.has(character)
        ? "-"
        : character,
    )
    .join("")
    .replace(TRAILING_WINDOWS_SEGMENT_CHARS, "")
    .trim();
  return normalized || fallback;
}

/**
 * 学生课堂的回退工作区名称必须包含 classroom.id。
 * 同一课时重复开课时 lesson 标题相同，只有课堂 id 能区分两场课堂及其任务历史。
 */
export function buildLingdongClassroomWorkspaceName(input: {
  readonly displayName?: string;
  readonly login?: string;
  readonly lessonTitle?: string;
  readonly classroomTitle?: string;
  readonly classroomId: string;
}): string {
  const student = sanitizeLingdongWorkspaceSegment(
    input.displayName || input.login || "学生",
    "学生",
  ).slice(0, 48);
  const lesson = sanitizeLingdongWorkspaceSegment(
    input.lessonTitle || input.classroomTitle || "课堂",
    "课堂",
  ).slice(0, 80);
  const classroom = sanitizeLingdongWorkspaceSegment(input.classroomId, "课堂").slice(0, 64);
  return `${student}-${lesson}-${classroom}`;
}
