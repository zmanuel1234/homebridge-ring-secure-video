#!/usr/bin/env node
// Checks the package against Homebridge's plugin rules (the "Verified by Homebridge"
// requirements that can be checked from the repository) before CI passes or a release
// is published. Usage: node .github/scripts/check-homebridge.mjs [--release]
//   --release  also requires a CHANGELOG.md section for the version in package.json
//              and a built lib/ (run after `npm run build`).
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import console from 'node:console'

const release = process.argv.includes('--release')
const errors = []
const fail = (msg) => errors.push(msg)
const read = (file) => readFileSync(file, 'utf8')

const pkg = JSON.parse(read('package.json'))
let schema
try {
  schema = JSON.parse(read('config.schema.json'))
} catch (e) {
  fail(`config.schema.json is not valid JSON: ${e.message}`)
}

// Package identity and discovery.
if (!/^(@[^/]+\/)?homebridge-/.test(pkg.name ?? '')) fail('package name must start with "homebridge-"')
if (!pkg.displayName) fail('package.json needs a displayName (shown in the Homebridge UI)')
if (!pkg.keywords?.includes('homebridge-plugin')) fail('keywords must include "homebridge-plugin"')
if (!pkg.license) fail('package.json needs a license')
if (!/github\.com/.test(pkg.repository?.url ?? '')) fail('repository must point at the GitHub repository')
if (!/github\.com\/.+\/issues/.test(pkg.bugs?.url ?? '')) fail('bugs.url must point at the GitHub issues page')

// Supported environments: Homebridge 2 and every Node LTS Homebridge supports (22, 24, 26).
// Accepts ranges written as "^22", ">=22", "^22 || ^24" and the like.
const covers = (range, major) =>
  range.split('||').some((alt) => {
    if (alt.includes('<')) return false // an upper bound could exclude this major; keep ranges simple
    const m = alt.trim().match(/^(\^|~|>=)?\s*v?(\d+)/)
    if (!m) return false
    const base = Number(m[2])
    return m[1] === '>=' ? base <= major : base === major
  })
const nodeRange = pkg.engines?.node ?? ''
for (const major of [22, 24, 26]) {
  if (!covers(nodeRange, major)) fail(`engines.node must include Node ${major} (Homebridge's supported LTS)`)
}
if (!pkg.engines?.homebridge) fail('engines.homebridge is missing')
else if (!covers(pkg.engines.homebridge, 2)) fail('engines.homebridge must allow Homebridge 2')

// Settings GUI: the schema's alias must match the platform the plugin registers.
if (pkg.homebridge?.pluginType !== 'platform') fail('homebridge.pluginType must be "platform" (dynamic platform)')
if (schema) {
  if (schema.pluginAlias !== pkg.homebridge?.pluginAlias) {
    fail(`config.schema.json pluginAlias "${schema.pluginAlias}" differs from package.json "${pkg.homebridge?.pluginAlias}"`)
  }
  if (schema.pluginType !== 'platform') fail('config.schema.json pluginType must be "platform"')
  if (!schema.schema?.properties) fail('config.schema.json has no schema.properties')
}
const platformSource = read('ring-platform.ts')
const declared = platformSource.match(/export const platformName = '([^']+)'/)?.[1]
const declaredPlugin = platformSource.match(/export const pluginName = '([^']+)'/)?.[1]
if (declared !== pkg.homebridge?.pluginAlias) fail(`ring-platform.ts platformName "${declared}" differs from the pluginAlias "${pkg.homebridge?.pluginAlias}"`)
if (!/\.registerPlatform\(/.test(read('index.ts'))) fail('index.ts must register the platform (dynamic platform)')
if (declaredPlugin !== pkg.name) fail(`ring-platform.ts pluginName "${declaredPlugin}" differs from the package name "${pkg.name}"`)

// No install-time scripts that could change the user's system.
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (pkg.scripts?.[hook]) fail(`package.json must not have a "${hook}" script`)
}

// What npm would publish.
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0]
const files = new Set(packed.files.map((f) => f.path))
for (const needed of ['package.json', 'config.schema.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  if (!files.has(needed)) fail(`the npm package would not contain ${needed}`)
}
for (const f of files) {
  if (/(^|\/)(test|\.github)\//.test(f) || /^scripts\//.test(f) || /\.tgz$/.test(f) || /(^|\/)\.env/.test(f)) fail(`the npm package would contain ${f}`)
}

if (release) {
  const main = pkg.main?.replace(/^\.\//, '')
  if (!main || !existsSync(main)) fail(`the built entry point ${pkg.main} is missing (run npm run build first)`)
  else if (!files.has(main)) fail(`the npm package would not contain ${main}`)
  const changelog = read('CHANGELOG.md')
  const heading = new RegExp(`^##+ \\[?v?${pkg.version.replace(/[.+]/g, '\\$&')}\\]?(\\s|$)`, 'm')
  if (!heading.test(changelog)) fail(`CHANGELOG.md has no "## ${pkg.version}" section`)
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log(`Homebridge checks passed for ${pkg.name}@${pkg.version}${release ? ' (release)' : ''}`)
