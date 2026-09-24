/** Finite HTML-declared classic scripts and stylesheets; no module, CSS dependency or runtime fetch traversal. */
import type { HtmlAsset, HtmlBundle } from './bootstrap.ts'
import type { DocumentFileBytes } from '../rpc.ts'
import { decodeText } from './bytes.ts'

/**
 * A read bound to the original document's session and directory, using ordinary file operations.
 * @param reference - HTML-decoded relative URL, including any query or fragment; the reader resolves its file path.
 * @param signal - cancellation of this packing operation.
 * @returns complete file bytes; permission and read failures reject.
 */
export type ReadHtmlRelative = (reference: string, signal: AbortSignal) => Promise<DocumentFileBytes>

const MAX_ASSET_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ASSETS = 64

/** Whether this reference can be read relative to the original document, never the parent application URL. */
function relative(reference: string): boolean {
  return reference.length > 0 && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference) && !reference.includes('\0')
}

/**
 * Collect static dependencies without executing or mounting document elements in the parent page.
 * A base element leaves URL resolution to the browser. Only direct .js classic scripts and .css
 * links are packed; local CSS url/import, modules and dynamically constructed URLs are unsupported.
 * @param data - complete UTF-8 HTML bytes.
 * @param readRelative - original-document-scoped read, never exposed to the iframe.
 * @param signal - stops reads and prevents publication after cancellation.
 * @returns complete HTML and its finite static asset set; decoding, limits and read failures reject.
 */
export async function packHtml(
  data: Uint8Array<ArrayBuffer>,
  readRelative: ReadHtmlRelative,
  signal: AbortSignal,
): Promise<HtmlBundle> {
  signal.throwIfAborted()
  let total = data.byteLength
  if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit')
  const template = document.createElement('template')
  template.innerHTML = decodeText(data)
  const assets: HtmlAsset[] = []
  if (template.content.querySelector('base[href]') !== null) return { data, assets }

  const seen = new Set<string>()
  const mimeFor = (path: string): string => {
    const ext = path.slice(path.lastIndexOf('.')).toLocaleLowerCase('en-US')
    return ({
      '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
    } as Record<string, string>)[ext] ?? 'application/octet-stream'
  }
  const add = async (reference: string, kind: HtmlAsset['kind']): Promise<void> => {
    if (!relative(reference)) return
    const suffix = reference.search(/[?#]/u)
    const path = suffix === -1 ? reference : reference.slice(0, suffix)
    if (kind === 'script' && !/\.js$/iu.test(path)) return
    if (kind === 'stylesheet' && !/\.css$/iu.test(path)) return
    const key = `${kind}:${reference}`
    if (seen.has(key)) return
    if (assets.length >= MAX_ASSETS) throw new Error('HTML package exceeds its asset count limit')
    signal.throwIfAborted()
    const asset = await readRelative(reference, signal)
    signal.throwIfAborted()
    const size = asset.data.byteLength
    if (size > MAX_ASSET_BYTES) throw new Error('HTML asset exceeds its byte limit')
    total += size
    if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit')
    if (kind === 'script' || kind === 'stylesheet') decodeText(asset.data)
    assets.push({ kind, reference, data: asset.data, mime: mimeFor(path) })
    seen.add(key)
  }
  for (const element of template.content.querySelectorAll(
    'script[src],link[href],img[src],source[src],video[src],video[poster],audio[src]',
  )) {
    if (element.localName === 'script') {
      const type = element.getAttribute('type')?.trim().toLowerCase() ?? ''
      if (['', 'text/javascript', 'application/javascript'].includes(type)) {
        await add(element.getAttribute('src') as string, 'script')
      }
      continue
    }
    if (element.localName === 'link') {
      const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u)
      const href = element.getAttribute('href') as string
      if (rel.includes('stylesheet')) await add(href, 'stylesheet')
      else if (rel.includes('icon') && /\.(?:png|jpe?g|gif|webp|svg|ico)$/iu.test(href)) await add(href, 'image')
      continue
    }
    if (element.localName === 'img') { await add(element.getAttribute('src') as string, 'image'); continue }
    if (element.localName === 'video' && element.hasAttribute('poster')) {
      await add(element.getAttribute('poster') as string, 'image')
    }
    if (element.localName === 'video' && element.hasAttribute('src')) {
      await add(element.getAttribute('src') as string, 'binary')
    }
    if (element.localName === 'source') { await add(element.getAttribute('src') as string, 'binary'); continue }
    if (element.localName === 'audio') await add(element.getAttribute('src') as string, 'binary')
  }
  return { data, assets }
}
