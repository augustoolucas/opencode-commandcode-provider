import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "..")
const MODELS_JSON = join(ROOT, "models.json")
const README = join(ROOT, "README.md")

interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  tool_call: boolean
  cost: { input: number; output: number }
  limit: { context: number; output: number }
}

const models: ModelEntry[] = JSON.parse(readFileSync(MODELS_JSON, "utf-8"))

const sortedModels = [...models].sort((a, b) => {
  if (a.tier !== b.tier) return a.tier === "premium" ? -1 : 1
  return a.name.localeCompare(b.name)
})

const rows = sortedModels.map((m) => {
  const id = `\`${m.id}\``
  const tier = m.tier === "premium" ? "premium" : "open-source"
  const ctx = m.limit.context >= 1_000_000 ? `${(m.limit.context / 1_000_000).toFixed(0)}M` : `${(m.limit.context / 1000).toFixed(0)}K`
  return `| ${id.padEnd(42)} | ${m.name.padEnd(27)} | ${tier.padEnd(12)} | ${m.reasoning ? "yes" : "no".padEnd(3)} | ${ctx.padEnd(6)} |`
})

const tableHeader = "| Model ID | Name | Tier | Reasoning | Context |"
const separator = "|---|---|---|---|---|"
const table = [tableHeader, separator, ...rows].join("\n")

const readme = readFileSync(README, "utf-8")

const startMarker = "## Available Models"
const endMarker = "Models are automatically synced"

const startIdx = readme.indexOf(startMarker)
const endIdx = readme.indexOf(endMarker, startIdx)

if (startIdx === -1 || endIdx === -1) {
  console.error("Could not find Available Models section in README.md")
  process.exit(1)
}

const before = readme.slice(0, startIdx)
const after = readme.slice(endIdx)

const updated = `${before}${startMarker}\n\n${table}\n\n${after}`

writeFileSync(README, updated, "utf-8")
console.log(`Updated README.md with ${models.length} models`)
