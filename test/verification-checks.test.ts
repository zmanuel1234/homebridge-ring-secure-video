import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Patterns the Homebridge verification check (homebridge/plugins) flags for manual review in a
// plugin's built code, which this plugin has no reason to contain.
const root = fileURLToPath(new URL('..', import.meta.url))

// What the check reads: the .js, .ts and .json files of the installed package
async function builtFiles(dir = join(root, 'dist')): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await builtFiles(path)))
    else if (/\.(?:js|ts|json)$/.test(entry.name)) files.push(path)
  }
  return files
}

const packageFiles = async () => [
  ...(await builtFiles()),
  join(root, 'config.schema.json'),
  join(root, 'package.json'),
]

test('the built plugin reads no environment variables or .env files', async () => {
  for (const file of await packageFiles()) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /\.env/, file)
  }
})

test('the built plugin writes no file through writeFileSync with a file descriptor', async () => {
  // the check logs it as a write to a file named after the descriptor, outside the storage folder
  for (const file of await builtFiles()) {
    // (code, not a comment)
    assert.doesNotMatch(await readFile(file, 'utf8'), /^(?!\s*\/\/).*writeFileSync\(\s*fd\b/m, file)
  }
})
