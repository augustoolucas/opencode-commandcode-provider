import { readFileSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  tool_call: boolean
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
}

interface ApiModel {
  id: string
  context_length?: number
}

function loadModels(): ModelEntry[] {
  try {
    const modelsPath = join(__dirname, "models.json")
    return JSON.parse(readFileSync(modelsPath, "utf-8"))
  } catch {
    return []
  }
}

function saveModels(models: ModelEntry[]): void {
  try {
    const modelsPath = join(__dirname, "models.json")
    const serialized = JSON.stringify(models, null, 2) + "\n"
    const existing = (() => {
      try {
        return readFileSync(modelsPath, "utf-8")
      } catch {
        return null
      }
    })()
    if (existing === serialized) return
    writeFileSync(modelsPath, serialized, "utf-8")
  } catch {
    // silent — non-fatal
  }
}

async function fetchModelsFromApi(): Promise<ApiModel[] | null> {
  const apiKey = process.env.COMMANDCODE_API_KEY
  if (!apiKey) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const resp = await fetch("https://api.commandcode.ai/provider/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })

    if (!resp.ok) return null
    const data = (await resp.json()) as { data?: ApiModel[] }
    return data.data ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export function mergeModels(local: ModelEntry[], api: ApiModel[]): ModelEntry[] {
  const apiMap = new Map(api.map((m) => [m.id, m]))
  const merged: ModelEntry[] = []

  for (const entry of local) {
    const apiModel = apiMap.get(entry.id)
    if (apiModel?.context_length) {
      merged.push({ ...entry, limit: { ...entry.limit, context: apiModel.context_length } })
    } else {
      merged.push(entry)
    }
    apiMap.delete(entry.id)
  }

  for (const [id, apiModel] of apiMap) {
    merged.push({
      id,
      name: id.split("/").pop() ?? id,
      tier: "open-source",
      reasoning: false,
      tool_call: true,
      cost: { input: 0.5, output: 2 },
      limit: { context: apiModel.context_length ?? 131072, output: 131072 },
    })
  }

  return merged
}

function toConfigKey(id: string): string {
  const slashIdx = id.indexOf("/")
  const short = slashIdx >= 0 ? id.slice(slashIdx + 1) : id
  return short.toLowerCase()
}

export default async function commandcodePlugin() {
  return {
    config: async (config: Record<string, unknown>) => {
      const providers = config.provider as Record<string, Record<string, unknown>> | undefined
      if (!providers) {
        (config as Record<string, unknown>).provider = { commandcode: {} }
      }
      const cc = ((config as Record<string, unknown>).provider as Record<string, Record<string, unknown>>)?.commandcode as Record<string, unknown> | undefined
      if (!cc) return

      if (!cc.npm) cc.npm = "commandcode-go-opencode-provider"
      if (!cc.name) cc.name = "Command Code"
      if (!cc.env) cc.env = ["COMMANDCODE_API_KEY"]

      if (!cc.models) {
        let models = loadModels()
        const apiModels = await fetchModelsFromApi()
        if (apiModels && apiModels.length > 0) {
          models = mergeModels(models, apiModels)
          saveModels(models)
        }
        const modelsObj: Record<string, unknown> = {}
        for (const entry of models) {
          const key = toConfigKey(entry.id)
          const costObj: Record<string, number> = { input: entry.cost.input, output: entry.cost.output }
          if (entry.cost.cache_read !== undefined) costObj.cache_read = entry.cost.cache_read
          if (entry.cost.cache_write !== undefined) costObj.cache_write = entry.cost.cache_write

          modelsObj[key] = {
            id: entry.id,
            name: entry.name,
            reasoning: entry.reasoning,
            tool_call: entry.tool_call,
            cost: costObj,
            limit: entry.limit,
          }
        }
        cc.models = modelsObj
      }
    },

    auth: {
      provider: "commandcode",
      methods: [
        {
          type: "api",
          label: "API Key",
          authorize: async (inputs: Record<string, unknown> | undefined) => {
            const rawKey = inputs?.key
            if (typeof rawKey !== "string") return { type: "failed" as const }
            const key = rawKey.trim()
            if (!key) return { type: "failed" as const }
            return { type: "success" as const, key }
          },
        },
      ],
      loader: async (getAuth: () => Promise<{ type: string; key?: string } | null>) => {
        try {
          const auth = await getAuth()
          if (!auth) return {}
          if (auth.type === "api" && auth.key) return { apiKey: auth.key }
          return {}
        } catch {
          return {}
        }
      },
    },
  }
}
