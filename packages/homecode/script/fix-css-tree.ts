#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

// css-tree uses createRequire to load JSON files which doesn't work in a compiled Bun binary.
// Patch the files to inline the JSON data directly.

async function findCssTreeDir() {
  const localPath = path.join(dir, "node_modules", "css-tree")
  try {
    const stat = await fs.stat(localPath)
    if (stat.isDirectory()) return localPath
  } catch {}

  // Check bun cache
  const bunCache = path.join(dir, "..", "..", "node_modules", ".bun", "css-tree@3.2.1", "node_modules", "css-tree")
  return bunCache
}

async function findMdnDataDir() {
  const bunCache = path.join(dir, "..", "..", "node_modules", ".bun", "mdn-data@2.27.1", "node_modules", "mdn-data")
  try {
    const stat = await fs.stat(bunCache)
    if (stat.isDirectory()) return bunCache
  } catch {}
  return null
}

async function fixCssTree() {
  const cssTreeDir = await findCssTreeDir()

  try {
    const stat = await fs.stat(cssTreeDir)
    if (!stat.isDirectory()) return
  } catch {
    return
  }

  const libDir = path.join(cssTreeDir, "lib")

  // Fix data-patch.js: inline the patch.json content
  const dataPatchPath = path.join(libDir, "data-patch.js")
  try {
    const content = await fs.readFile(dataPatchPath, "utf8")
    if (!content.includes("createRequire")) return

    const patchJson = await fs.readFile(path.join(cssTreeDir, "data", "patch.json"), "utf8")
    const patchObj = JSON.parse(patchJson)
    const fixed = `const patch = ${JSON.stringify(patchObj, null, 2)};

export default patch;
`
    await fs.writeFile(dataPatchPath, fixed)
    console.log("patched css-tree lib/data-patch.js")
  } catch {
    return
  }

  // Fix data.js: inline the mdn-data JSON content
  const dataPath = path.join(libDir, "data.js")
  try {
    const content = await fs.readFile(dataPath, "utf8")
    if (!content.includes("createRequire")) return

    const mdnDataDir = await findMdnDataDir()
    if (!mdnDataDir) {
      console.error("mdn-data directory not found, cannot patch data.js")
      return
    }

    const mdnAtrules = JSON.parse(await fs.readFile(path.join(mdnDataDir, "css", "at-rules.json"), "utf8"))
    const mdnProperties = JSON.parse(await fs.readFile(path.join(mdnDataDir, "css", "properties.json"), "utf8"))
    const mdnSyntaxes = JSON.parse(await fs.readFile(path.join(mdnDataDir, "css", "syntaxes.json"), "utf8"))

    // Read the original file and just replace the top section
    const originalContent = content
    const lines = originalContent.split("\n")
    // Find the line after the createRequire section
    let startIndex = 0
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("const hasOwn")) {
        startIndex = i
        break
      }
    }

    const restOfContent = lines.slice(startIndex).join("\n")
    const fixed = `import patch from './data-patch.js';

const mdnAtrules = ${JSON.stringify(mdnAtrules)};
const mdnProperties = ${JSON.stringify(mdnProperties)};
const mdnSyntaxes = ${JSON.stringify(mdnSyntaxes)};

${restOfContent}
`
    await fs.writeFile(dataPath, fixed)
    console.log("patched css-tree lib/data.js")
  } catch {
    return
  }

  // Fix version.js: inline the version
  const versionPath = path.join(libDir, "version.js")
  try {
    const content = await fs.readFile(versionPath, "utf8")
    if (!content.includes("createRequire")) return

    const pkg = JSON.parse(await fs.readFile(path.join(cssTreeDir, "package.json"), "utf8"))
    const fixed = `export const version = ${JSON.stringify(pkg.version)};
`
    await fs.writeFile(versionPath, fixed)
    console.log("patched css-tree lib/version.js")
  } catch {
    return
  }
}

await fixCssTree()
