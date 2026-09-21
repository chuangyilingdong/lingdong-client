/** Patch the prepared desktop runtime so native LibreOffice loads from a short resources path. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function platformPackageName(platform, arch) {
  const target = platform === 'win32' ? `win32-${arch}` : platform === 'darwin' ? `darwin-${arch}` : ''
  if (!target) throw new Error(`lingdong office engine: unsupported platform ${platform}`)
  return `libreoffice-kit-${target}`
}

export function patchLingdongOfficeEngine(dshRoot, platform, arch) {
  const packageName = platformPackageName(platform, arch)
  const engineRoot = join(dshRoot, 'node_modules', '@deepseek-ai', packageName)
  if (!existsSync(join(engineRoot, 'prebuilds.json'))) {
    throw new Error(`lingdong office engine: missing prepared engine ${packageName} at ${engineRoot}`)
  }

  const file = join(dshRoot, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js')
  const before = readFileSync(file, 'utf8')
  if (before.includes('LINGDONG_LIBREOFFICE_ENGINE_DIR')) return
  const anchor = `\tconst details = platform === "linux" ? report() : {};\n\tconst target = platformTarget(platform, arch, () => details);`
  const replacement = `${anchor}\n\tconst override = process.env.LINGDONG_LIBREOFFICE_ENGINE_DIR;\n\tif (typeof override === "string" && override !== "" && target !== void 0) {\n\t\tconst packageFile = join(override, "package.json");\n\t\tif (lstatSync(packageFile, { throwIfNoEntry: false }) !== void 0) return readEngine(packageFile, "native", target);\n\t}`
  if (!before.includes(anchor)) throw new Error('lingdong office engine: resolver anchor missing')
  writeFileSync(file, before.replace(anchor, replacement), 'utf8')
}