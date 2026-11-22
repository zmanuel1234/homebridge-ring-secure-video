import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

// Patterns the Homebridge verification check (homebridge/plugins) flags for manual review in a
// plugin's built code, which this plugin has no reason to contain.
const lib = new URL('../lib/', import.meta.url).pathname

async function builtFiles(dir = lib) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await builtFiles(path)))
    else if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

test('the built plugin reads no environment variables or .env files', async () => {
  for (const file of await builtFiles()) {
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
