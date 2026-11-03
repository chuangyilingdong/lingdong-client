export const FILE_NAME_PATTERN: RegExp;
export function downloadTextFile(filename: string, content: string, mime?: string): void;
export function parseFenceInfo(raw: unknown): { lang: string; filename: string };
export function escapeHtml(value: unknown): string;
export const SANDBOX_STORAGE_SHIM: string;
export const CONSOLE_BRIDGE: string;
export const PREVIEW_HEIGHT_BRIDGE: string;
export const ASSET_FETCH_BRIDGE: string;
export const LLM_BRIDGE: string;
export const PDF_BRIDGE: string;

export interface WorksLlmPreviewGrant {
  readonly grant?: string;
  /** 客户端本地预览服务使用的平台 API 地址；平台页面不需要传。 */
  readonly endpoint?: string;
}

export function buildPreviewDocument(
  files: Record<string, string> | null | undefined,
  entryFile: string,
  options?: { worksLlm?: WorksLlmPreviewGrant | null },
): string;

export function isSubmittableArtifact(artifact: unknown): boolean;