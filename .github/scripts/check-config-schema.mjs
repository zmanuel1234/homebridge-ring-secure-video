#!/usr/bin/env node
// Checks that the Homebridge settings form and JSON config editor can use config.schema.json,
// and that the README's JSON examples are valid configuration.
// Usage: node .github/scripts/check-config-schema.mjs
import { readFileSync } from 'node:fs'
import process from 'node:process'
import console from 'node:console'
import Ajv from 'ajv'

const errors = []
const fail = (msg) => errors.push(msg)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const file = JSON.parse(readFileSync('config.schema.json', 'utf8'))
const schema = file.schema

// Homebridge's form also accepts `"required": true` on a single setting, which standard JSON
// Schema doesn't. Convert those into the parent's `required` list before compiling.
function standardise(node) {
  if (!isObject(node)) return node
  const out = { ...node }
  if (isObject(node.properties)) {
    out.properties = {}
    const required = Array.isArray(node.required) ? [...node.required] : []
    for (const [key, prop] of Object.entries(node.properties)) {
      const copy = standardise(prop)
      if (prop?.required === true) required.push(key)
      if (typeof copy.required === 'boolean') delete copy.required
      out.properties[key] = copy
    }
    if (required.length) out.required = [...new Set(required)]
  }
  if (isObject(node.items)) out.items = standardise(node.items)
  return out
}
const standard = standardise(schema)

// 1. It is a JSON Schema the editor can compile. Homebridge's form adds its own keywords
//    (placeholder, condition, ...), so unknown keywords are allowed but structure is checked.
const ajv = new Ajv({ strict: false, allErrors: true })
let validate
try {
  validate = ajv.compile(standard)
} catch (e) {
  fail(`config.schema.json "schema" does not compile: ${e.message}`)
}

// 2. Every setting has a title (the form's label) and a type, and its default is valid.
function walk(properties, path) {
  for (const [key, prop] of Object.entries(properties ?? {})) {
    const where = path ? `${path}.${key}` : key
    if (!prop.title) fail(`setting ${where} has no title`)
    if (!prop.type) fail(`setting ${where} has no type`)
    if (validate && prop.default !== undefined) {
      const ownSchema = standardise({ ...prop, required: undefined })
      delete ownSchema.default
      delete ownSchema.required
      if (!ajv.validate(ownSchema, prop.default)) fail(`setting ${where} has an invalid default: ${ajv.errorsText()}`)
    }
    if (prop.type === 'object') walk(prop.properties, where)
    if (prop.type === 'array' && prop.items?.type === 'object') walk(prop.items.properties, `${where}[]`)
  }
}
walk(schema?.properties, '')

// 3. The form layout only refers to settings that exist (a wrong key breaks the form).
function propertyAt(path) {
  let props = schema?.properties
  let prop
  for (const part of path.split('.')) {
    const isArrayItem = part.endsWith('[]')
    prop = props?.[isArrayItem ? part.slice(0, -2) : part]
    if (!prop) return undefined
    if (isArrayItem && prop.type !== 'array') return undefined
    props = prop.type === 'array' ? prop.items?.properties : prop.properties
  }
  return prop
}
function layoutKeys(items, out = []) {
  for (const item of items ?? []) {
    if (typeof item === 'string') out.push(item)
    else if (isObject(item)) {
      if (item.key) out.push(item.key)
      layoutKeys(item.items, out)
    }
  }
  return out
}
for (const key of layoutKeys(file.layout)) {
  if (!propertyAt(key)) fail(`the form layout refers to "${key}", which config.schema.json doesn't define`)
}

// 4. JSON examples in the README parse and are valid settings. Examples may show only some
//    settings, so required settings are not enforced, but unknown (misspelt or renamed)
//    settings are. "platform" and "_bridge" belong to Homebridge, not to the plugin.
const forExamples = validate
  ? ajv.compile({ ...standard, required: [], additionalProperties: false })
  : undefined
const readme = readFileSync('README.md', 'utf8')
const blocks = [...readme.matchAll(/^[ \t]*```json[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gim)].map((m) => m[1])
if (blocks.length === 0) fail('found no ```json examples in README.md (the check would be checking nothing)')
blocks.forEach((text, i) => {
  let example
  try {
    example = JSON.parse(text)
  } catch (e) {
    fail(`README JSON example ${i + 1} is not valid JSON: ${e.message}`)
    return
  }
  if (!isObject(example)) {
    fail(`README JSON example ${i + 1} is not a settings object`)
    return
  }
  if (example.platform !== undefined && example.platform !== file.pluginAlias) {
    fail(`README JSON example ${i + 1} uses platform "${example.platform}", not "${file.pluginAlias}"`)
  }
  const settings = { ...example }
  delete settings.platform
  delete settings._bridge
  if (forExamples && !forExamples(settings)) {
    for (const err of forExamples.errors) {
      const extra = err.params?.additionalProperty ? ` ("${err.params.additionalProperty}")` : ''
      fail(`README JSON example ${i + 1}: ${err.instancePath || '(top)'} ${err.message}${extra}`)
    }
  }
})

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log(`config.schema.json and ${blocks.length} README JSON examples are valid`)
