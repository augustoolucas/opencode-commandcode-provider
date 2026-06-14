import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execSync } from "child_process"

const PROJECT_ROOT = join(import.meta.dir, "..")
const MODELS_JSON = join(PROJECT_ROOT, "models.json")
const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc")
const NPM_PACKAGE = "command-code"
const TMP_DIR = join("/tmp", "cc-model-sync")
// Authoritative, OpenAI-compatible model listing. Source of truth for which models exist,
// their display names, and context windows. Pricing is not exposed here, so cost data is
// enriched from the CLI bundle (see fetchLatestBundle / extractCostData).
const MODELS_ENDPOINT = "https://api.commandcode.ai/provider/v1/models"

interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  tool_call: boolean
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
  variants?: Record<string, Record<string, unknown>>
}

interface CostEntry {
  id: string
  provider: string
  category: string
  promptCost: number
  completionCost: number
  cacheWrite5mCost: number
  cacheWrite1hCost: number
  cacheHitCost: number
}

interface EndpointModel {
  id: string
  name: string
  context_length: number
}

// Per-model overrides for fields the /provider/v1/models endpoint does not expose
// (reasoning capability, tool-call support). Anything not listed falls back to sensible
// defaults in buildModelEntry (reasoning: true, tool_call: true).
interface ModelMeta {
  reasoning?: boolean
  tool_call?: boolean
}

// Models that are NOT reasoning-capable. Everything else defaults to reasoning: true.
// (Output limits live in FALLBACK_LIMITS; tool_call defaults to true.)
const MODEL_META: Record<string, ModelMeta> = {
  "claude-haiku-4-5-20251001": { reasoning: false },
  "zai-org/GLM-5": { reasoning: false },
  "zai-org/GLM-5.1": { reasoning: false },
  "moonshotai/Kimi-K2.5": { reasoning: false },
  "moonshotai/Kimi-K2.6": { reasoning: false },
  "MiniMaxAI/MiniMax-M2.5": { reasoning: false },
  "MiniMaxAI/MiniMax-M2.7": { reasoning: false },
}

const FALLBACK_COSTS: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cache_read: 0.003625 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.01 },
  "zai-org/GLM-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "Qwen/Qwen3.6-Max-Preview": { input: 1.3, output: 7.8, cache_read: 0.26, cache_write: 1.63 },
  "Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cache_read: 0.1 },
  "Qwen/Qwen3.7-Max": { input: 1.25, output: 3.75, cache_read: 0.25, cache_write: 1.56 },
  "stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cache_read: 0.02 },
  "google/gemini-3.5-flash": { input: 1.5, output: 9, cache_read: 0.15 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cache_read: 0.03 },
}

const FALLBACK_LIMITS: Record<string, { context: number; output: number }> = {
  "claude-haiku-4-5-20251001": { context: 200000, output: 8192 },
  "claude-opus-4-6": { context: 200000, output: 32000 },
  "claude-opus-4-7": { context: 200000, output: 32000 },
  "claude-sonnet-4-6": { context: 200000, output: 16000 },
  "gpt-5.5": { context: 256000, output: 128000 },
  "gpt-5.4": { context: 256000, output: 128000 },
  "gpt-5.3-codex": { context: 256000, output: 128000 },
  "gpt-5.4-mini": { context: 256000, output: 128000 },
  "moonshotai/Kimi-K2.6": { context: 262144, output: 131072 },
  "moonshotai/Kimi-K2.5": { context: 262144, output: 131072 },
  "zai-org/GLM-5": { context: 200000, output: 131072 },
  "zai-org/GLM-5.1": { context: 200000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.5": { context: 1000000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.7": { context: 1000000, output: 131072 },
  "deepseek/deepseek-v4-pro": { context: 1000000, output: 384000 },
  "deepseek/deepseek-v4-flash": { context: 1000000, output: 384000 },
  "Qwen/Qwen3.6-Max-Preview": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.6-Plus": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.7-Max": { context: 1000000, output: 131072 },
  "stepfun/Step-3.5-Flash": { context: 1000000, output: 131072 },
  "google/gemini-3.5-flash": { context: 1000000, output: 65536 },
  "google/gemini-3.1-flash-lite": { context: 1000000, output: 65536 },
}

async function fetchModelList(): Promise<EndpointModel[]> {
  console.log(`Fetching model list from ${MODELS_ENDPOINT}...`)
  const resp = await fetch(MODELS_ENDPOINT)
  if (!resp.ok) throw new Error(`models endpoint returned ${resp.status}`)
  const json = (await resp.json()) as { data?: Array<{ id: string; name: string; context_length: number }> }
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error("models endpoint returned no models")
  }
  return json.data.map((m) => ({ id: m.id, name: m.name, context_length: m.context_length }))
}

async function fetchLatestBundle(): Promise<{ source: string; version: string }> {
  console.log(`Fetching latest ${NPM_PACKAGE} metadata...`)
  const metaResp = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`)
  if (!metaResp.ok) throw new Error(`npm registry returned ${metaResp.status}`)
  const meta = await metaResp.json()
  const version = meta.version as string
  const tarball = meta.dist.tarball as string
  console.log(`  Latest version: ${version}`)
  console.log(`  Tarball: ${tarball}`)

  mkdirSync(TMP_DIR, { recursive: true })
  const tgzPath = join(TMP_DIR, `${NPM_PACKAGE}.tgz`)

  console.log("Downloading tarball...")
  const tarballResp = await fetch(tarball)
  if (!tarballResp.ok) throw new Error(`tarball download returned ${tarballResp.status}`)
  const buffer = Buffer.from(await tarballResp.arrayBuffer())
  writeFileSync(tgzPath, buffer)

  console.log("Extracting...")
  execSync(`tar -xzf "${tgzPath}" -C "${TMP_DIR}"`, { stdio: "pipe" })

  const bundlePath = join(TMP_DIR, "package", "dist", "index.mjs")
  if (!existsSync(bundlePath)) throw new Error(`Bundle not found at ${bundlePath}`)

  const source = readFileSync(bundlePath, "utf-8")

  rmSync(TMP_DIR, { recursive: true, force: true })

  return { source, version }
}

function findBalancedObject(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor)
  if (anchorIdx < 0) throw new Error(`Anchor not found: ${anchor}`)

  let parenIdx = anchorIdx - 1
  while (parenIdx >= 0 && source[parenIdx] !== "(") parenIdx--
  if (parenIdx < 0) throw new Error(`Could not find opening ( before anchor: ${anchor}`)

  const braceStart = source.indexOf("{", parenIdx)
  if (braceStart < 0) throw new Error(`Could not find { after opening (`)

  let depth = 0
  let end = braceStart
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++
    else if (source[end] === "}") {
      depth--
      if (depth === 0) break
    }
  }

  return source.slice(braceStart, end + 1)
}

function evaluateWithContext(code: string, context: Record<string, unknown>): any {
  const keys = Object.keys(context)
  const values = keys.map((k) => context[k])
  const fn = Function(...keys, `"use strict"; return (${code})`)
  return fn(...values)
}

function extractWt(source: string): Record<string, string> {
  const raw = findBalancedObject(source, 'ANTHROPIC:"anthropic"')
  return evaluateWithContext(normalizeForEval(raw), {})
}

function extractCostData(source: string, wt: Record<string, string>, wtName: string): Record<string, CostEntry[]> {
  const anchor = '{id:"anthropic:claude-sonnet-4-'
  const anchorIdx = source.indexOf(anchor)
  if (anchorIdx < 0) throw new Error("Could not find cost data anchor")

  let braceDepth = 0
  let start = anchorIdx - 1
  for (; start >= 0; start--) {
    if (source[start] === "}") braceDepth++
    else if (source[start] === "{") {
      if (braceDepth === 0) break
      braceDepth--
    }
  }

  let depth = 0
  let end = start
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++
    else if (source[end] === "}") {
      depth--
      if (depth === 0) break
    }
  }

  const raw = source.slice(start, end + 1)
  return evaluateWithContext(normalizeForEval(raw), { [wtName]: wt }) as Record<string, CostEntry[]>
}

function getWtVarName(source: string): string {
  const idx = source.indexOf('ANTHROPIC:"anthropic"')
  if (idx < 0) throw new Error("Could not find Wt enum")
  const before = source.slice(Math.max(0, idx - 50), idx)
  const match = before.match(/\(([A-Za-z_$]+)=\{$/)
  if (match) return match[1]
  const match2 = before.match(/([A-Za-z_$]+)=\{$/)
  if (match2) return match2[1]
  throw new Error("Could not determine Wt variable name")
}

function normalizeForEval(code: string): string {
  return code
    .replace(/!0/g, "true")
    .replace(/!1/g, "false")
    .replace(/(\d+)e(\d+)/g, (_: string, m: string, e: string) =>
      String(Number(m) * Math.pow(10, Number(e)))
    )
}

function buildCostMap(costs: Record<string, CostEntry[]>): Map<string, CostEntry> {
  const map = new Map<string, CostEntry>()
  for (const arr of Object.values(costs)) {
    for (const entry of arr) {
      const colonIdx = entry.id.indexOf(":")
      const bareId = colonIdx >= 0 ? entry.id.slice(colonIdx + 1) : entry.id
      map.set(bareId, entry)
    }
  }
  return map
}

function buildModelEntry(model: EndpointModel, costMap: Map<string, CostEntry>): ModelEntry {
  // Namespaced ids (e.g. "deepseek/...", "xiaomi/...") are open-source; bare ids
  // (claude-*, gpt-*) are premium. Matches every model the endpoint currently serves.
  const tier: "premium" | "open-source" = model.id.includes("/") ? "open-source" : "premium"

  const costEntry = costMap.get(model.id)
  let cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  if (costEntry) {
    cost = { input: costEntry.promptCost, output: costEntry.completionCost }
    if (costEntry.cacheHitCost > 0) cost.cache_read = costEntry.cacheHitCost
    if (costEntry.cacheWrite5mCost > 0) cost.cache_write = costEntry.cacheWrite5mCost
  } else if (FALLBACK_COSTS[model.id]) {
    cost = FALLBACK_COSTS[model.id]!
  } else {
    // New/unpriced model: keep it in the list with zeroed cost rather than dropping it.
    console.warn(`  No cost data for ${model.id} — defaulting to 0 (add to FALLBACK_COSTS to fix)`)
    cost = { input: 0, output: 0 }
  }

  const meta = MODEL_META[model.id]
  const limit = {
    context: model.context_length ?? FALLBACK_LIMITS[model.id]?.context ?? 200000,
    output: FALLBACK_LIMITS[model.id]?.output ?? 65536,
  }

  return {
    id: model.id,
    name: model.name,
    tier,
    reasoning: meta?.reasoning ?? true,
    tool_call: meta?.tool_call ?? true,
    cost,
    limit,
    variants: entry.reasoningEfforts?.length
      ? Object.fromEntries(
          entry.reasoningEfforts.map((e) => [e, { reasoningEffort: e }] as const),
        )
      : entry.reasoning
        ? {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
          }
        : undefined,
  }
}

function toConfigKey(id: string): string {
  const slashIdx = id.indexOf("/")
  const short = slashIdx >= 0 ? id.slice(slashIdx + 1) : id
  return short.toLowerCase()
}

function generateOpencodeModels(entries: ModelEntry[]): Record<string, unknown> {
  const models: Record<string, unknown> = {}
  for (const entry of entries) {
    const key = toConfigKey(entry.id)
    const costObj: Record<string, number> = { input: entry.cost.input, output: entry.cost.output }
    if (entry.cost.cache_read !== undefined) costObj.cache_read = entry.cost.cache_read
    if (entry.cost.cache_write !== undefined) costObj.cache_write = entry.cost.cache_write

    models[key] = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      tool_call: entry.tool_call,
      cost: costObj,
      limit: entry.limit,
      ...(entry.variants ? { variants: entry.variants } : {}),
    }
  }
  return models
}

function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '"') {
      const start = i
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++
        i++
      }
      i++
      out += input.slice(start, i)
    } else if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
    } else if (ch === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
    } else {
      out += ch
      i++
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function updateGlobalConfig(modelsObj: Record<string, unknown>) {
  if (!existsSync(GLOBAL_CONFIG)) {
    console.log(`  Global config not found at ${GLOBAL_CONFIG}, skipping`)
    return
  }

  const raw = readFileSync(GLOBAL_CONFIG, "utf-8")
  const jsonStr = stripJsonc(raw)

  let config: any
  try {
    config = JSON.parse(jsonStr)
  } catch {
    console.error("  Failed to parse global config as JSON after stripping comments")
    return
  }

  if (!config.provider) config.provider = {}
  if (!config.provider.commandcode) {
    config.provider.commandcode = {
      npm: "commandcode-go-opencode-provider",
      name: "Command Code",
      env: ["COMMANDCODE_API_KEY"],
    }
  }
  config.provider.commandcode.models = modelsObj

  const output = JSON.stringify(config, null, 2) + "\n"
  writeFileSync(GLOBAL_CONFIG, output, "utf-8")
  console.log(`  Updated ${GLOBAL_CONFIG}`)
}

async function main() {
  const args = process.argv.slice(2)
  const shouldUpdateGlobal = args.includes("--update-global")

  // Authoritative model list (id, name, context window).
  const list = await fetchModelList()
  console.log(`  Found ${list.length} models`)

  // CLI bundle is used only to enrich the list with pricing.
  const { source, version } = await fetchLatestBundle()
  console.log(`Read CLI bundle v${version} (${(source.length / 1024).toFixed(0)} KB)`)

  console.log("Extracting provider enum (Wt)...")
  const wt = extractWt(source)
  const wtName = getWtVarName(source)
  console.log(`  Provider enum var: ${wtName}, keys: ${Object.keys(wt).join(", ")}`)

  console.log("Extracting cost data...")
  const costs = extractCostData(source, wt, wtName)
  const costMap = buildCostMap(costs)
  console.log(`  Found ${costMap.size} cost entries`)

  const entries: ModelEntry[] = list.map((model) => buildModelEntry(model, costMap))

  entries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "premium" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  console.log(`\nWriting ${MODELS_JSON} with ${entries.length} models...`)
  writeFileSync(MODELS_JSON, JSON.stringify(entries, null, 2) + "\n", "utf-8")

  const modelsObj = generateOpencodeModels(entries)

  if (shouldUpdateGlobal) {
    console.log("Updating global config...")
    updateGlobalConfig(modelsObj)
  }

  console.log("\nModel list:")
  for (const entry of entries) {
    const cost = `$${entry.cost.input}/$${entry.cost.output}`
    console.log(`  ${entry.tier.padEnd(12)} ${entry.id.padEnd(35)} ${entry.name.padEnd(25)} ${cost}`)
  }

  if (!shouldUpdateGlobal) {
    console.log(`\nRun with --update-global to update ${GLOBAL_CONFIG}`)
  }

  console.log("\nDone.")
}

main()
