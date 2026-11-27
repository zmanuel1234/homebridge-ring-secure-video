#!/usr/bin/env node
// Shared by homebridge-brother-printer, homebridge-comelit-doorbell, homebridge-ir-patio-heater,
// homebridge-lg-thinq-connect and homebridge-ring-secure-video (the Homebridge plugins): the same
// file in all five. package.json's "verify" runs it, and "release:check" with --release.
//
// Checks the package against Homebridge's plugin rules (the "Verified by Homebridge"
// requirements that can be checked from the repository) before CI passes or a release
// is published. Usage: node .github/scripts/check-homebridge.mjs [--release]
//   --release  also requires a CHANGELOG.md section for the version in package.json
//              and the built entry point (run after `npm run build`).
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
// The transports the plugin publishes over (homebridge/plugins "Declaring Supported Transports"):
// HAP only; "supports-matter" is for plugins that register Matter accessories themselves.
if (!pkg.keywords?.includes('supports-hap')) fail('keywords must include "supports-hap"')
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
// package.json's optional "homebridge" section, where a plugin has one, must agree with the schema.
if (schema) {
  if (!schema.pluginAlias) fail('config.schema.json has no pluginAlias')
  if (schema.pluginType !== 'platform') fail('config.schema.json pluginType must be "platform" (dynamic platform)')
  if (!schema.schema?.properties) fail('config.schema.json has no schema.properties')
  if (pkg.homebridge?.pluginAlias !== undefined && pkg.homebridge.pluginAlias !== schema.pluginAlias) {
    fail(`package.json homebridge.pluginAlias "${pkg.homebridge.pluginAlias}" differs from config.schema.json "${schema.pluginAlias}"`)
  }
  if (pkg.homebridge?.pluginType !== undefined && pkg.homebridge.pluginType !== 'platform') {
    fail('package.json homebridge.pluginType must be "platform"')
  }
}
// The plugin's own code (not tests, the settings page's browser files or build output)
// registers the platform, under the schema's alias.
const sources = execFileSync('git', ['ls-files', '*.ts', '*.js', '*.mjs', '*.cjs'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.endsWith('.d.ts') && !/(^|\/)(test|\.github|node_modules|public)\//.test(f) && !/^(dist|lib)\//.test(f))
const code = sources.map(read).join('\n')
if (!/\.registerPlatform\(/.test(code)) fail('no source file registers the platform (api.registerPlatform)')
const alias = schema?.pluginAlias
if (alias && !new RegExp(`['"\`]${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(code)) {
  fail(`no source file names the platform "${alias}" (config.schema.json pluginAlias)`)
}

// No scripts that run when a user installs the plugin from npm and could change their system.
// ("prepare" runs only in a git checkout, to build it, never on an install from npm.)
for (const hook of ['preinstall', 'install', 'postinstall']) {
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
  const heading = new RegExp(`^##+ \\[?v?${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?(\\s|$)`, 'm')
  if (!heading.test(changelog)) fail(`CHANGELOG.md has no "## ${pkg.version}" section`)
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log(`Homebridge checks passed for ${pkg.name}@${pkg.version}${release ? ' (release)' : ''}`)
