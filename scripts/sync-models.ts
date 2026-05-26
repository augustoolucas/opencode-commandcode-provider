import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const PROJECT_ROOT = join(import.meta.dir, "..")
const MODELS_JSON = join(PROJECT_ROOT, "models.json")
const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc")
const LOCAL_CLI = join(PROJECT_ROOT, "node_modules", "command-code", "dist", "index.mjs")
const GLOBAL_CLI = join(homedir(), ".bun", "install", "global", "node_modules", "command-code", "dist", "index.mjs")

interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  tool_call: boolean
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
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

interface SnEntry {
  id: string
  provider: string
  spec: string
  label: string
  name: string
  description: string
  reasoning?: boolean
  reasoningEfforts?: string[]
  contextWindow?: number
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

const HARDCODED_EXTRAS: SnEntry[] = [
  {
    id: "google/gemini-3.5-flash",
    provider: "anthropic",
    spec: "chatComplete",
    label: "Gemini 3.5 Flash",
    name: "Gemini 3.5 Flash",
    description: "fast multimodal reasoning",
    reasoning: true,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    provider: "anthropic",
    spec: "chatComplete",
    label: "Gemini 3.1 Flash Lite",
    name: "Gemini 3.1 Flash Lite",
    description: "lightweight cost-effective flash",
  },
  {
    id: "Qwen/Qwen3.7-Max",
    provider: "vercel-ai-gateway",
    spec: "chatComplete",
    label: "Qwen 3.7 Max",
    name: "Qwen 3.7 Max",
    description: "latest Qwen Max model",
    reasoning: true,
  },
]

const TIER_MAP: Record<string, "premium" | "open-source"> = {
  "anthropic": "premium",
  "openai": "premium",
  "baseten": "open-source",
  "vercel-ai-gateway": "open-source",
  "openrouter": "open-source",
  "cloudflare-ai-gateway": "open-source",
}

function findCliBundle(): string {
  for (const p of [LOCAL_CLI, GLOBAL_CLI]) {
    if (existsSync(p)) return p
  }
  throw new Error(
    "command-code CLI not found. Install it:\n  bun add -d command-code"
  )
}

function evaluateLiteral(code: string): any {
  const prepared = code
    .replace(/!0/g, "true")
    .replace(/!1/g, "false")
    .replace(/(\d+)e(\d+)/g, (_, m: string, e: string) =>
      String(Number(m) * Math.pow(10, Number(e)))
    )
    .replace(/Wt\.ANTHROPIC/g, '"anthropic"')
    .replace(/Wt\.OPENAI/g, '"openai"')
    .replace(/Wt\.BASETEN/g, '"baseten"')
    .replace(/Wt\.VERCEL_AI_GATEWAY/g, '"vercel-ai-gateway"')
    .replace(/Wt\.OPENROUTER/g, '"openrouter"')
    .replace(/Wt\.CLOUDFLARE_AI_GATEWAY/g, '"cloudflare-ai-gateway"')
    .replace(/Wt\.GITHUB_COPILOT/g, '"github-copilot"')
    .replace(/\brn\b/g, '"chatComplete"')
    .replace(/\bon\b/g, '"responses"')
    .replace(/\bQt\b/g, '"vercel-ai-gateway"')
  return Function(`"use strict"; return (${prepared})`)()
}

function extractSn(source: string): Record<string, SnEntry> {
  const idx = source.indexOf("sn={")
  if (idx < 0) throw new Error("Could not find sn={ in CLI bundle")
  let depth = 0
  let end = idx + 3
  for (; end < source.length; end++) {
    const ch = source[end]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) break
    }
  }
  const raw = source.slice(idx + 3, end + 1)
  const entries = evaluateLiteral(raw) as Record<string, SnEntry>
  return entries
}

function extractKt(source: string): Record<string, CostEntry[]> {
  const idx = source.indexOf("Kt={")
  if (idx < 0) throw new Error("Could not find Kt={ in CLI bundle")
  let depth = 0
  let end = idx + 3
  for (; end < source.length; end++) {
    const ch = source[end]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) break
    }
  }
  const raw = source.slice(idx + 3, end + 1)
  return evaluateLiteral(raw) as Record<string, CostEntry[]>
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

function buildModelEntry(
  entry: SnEntry,
  costMap: Map<string, CostEntry>,
): ModelEntry | null {
  const provider = entry.provider || "unknown"
  const tier = TIER_MAP[provider] ?? "open-source"

  const costEntry = costMap.get(entry.id)
  let cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  if (costEntry) {
    cost = {
      input: costEntry.promptCost,
      output: costEntry.completionCost,
    }
    if (costEntry.cacheHitCost > 0) cost.cache_read = costEntry.cacheHitCost
    if (costEntry.cacheWrite5mCost > 0) cost.cache_write = costEntry.cacheWrite5mCost
  } else {
    const fallback = FALLBACK_COSTS[entry.id]
    if (!fallback) return null
    cost = fallback
  }

  const limit = entry.contextWindow
    ? { context: entry.contextWindow, output: FALLBACK_LIMITS[entry.id]?.output ?? 65536 }
    : FALLBACK_LIMITS[entry.id] ?? { context: 200000, output: 65536 }

  return {
    id: entry.id,
    name: entry.name,
    tier,
    reasoning: entry.reasoning || (entry.reasoningEfforts?.length ?? 0) > 0,
    tool_call: true,
    cost,
    limit,
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

function main() {
  const args = process.argv.slice(2)
  const shouldUpdateGlobal = args.includes("--update-global")

  const cliPath = findCliBundle()
  console.log(`Reading CLI bundle: ${cliPath}`)
  const source = readFileSync(cliPath, "utf-8")

  console.log("Extracting model catalog (sn)...")
  const sn = extractSn(source)
  console.log(`  Found ${Object.keys(sn).length} models in CLI`)

  console.log("Extracting cost data (Kt)...")
  const kt = extractKt(source)
  const costMap = buildCostMap(kt)
  console.log(`  Found ${costMap.size} cost entries`)

  const entries: ModelEntry[] = []

  for (const [, model] of Object.entries(sn)) {
    const entry = buildModelEntry(model, costMap)
    if (entry) {
      entries.push(entry)
    } else {
      console.warn(`  Skipping ${model.id}: no cost data`)
    }
  }

  for (const extra of HARDCODED_EXTRAS) {
    const entry = buildModelEntry(extra, costMap)
    if (entry) {
      console.log(`  Adding hardcoded extra: ${extra.id}`)
      entries.push(entry)
    }
  }

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
