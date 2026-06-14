import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const models = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "models.json"), "utf-8"),
) as Array<Record<string, unknown>>

test("models.json is a non-empty array", () => {
  expect(Array.isArray(models)).toBe(true)
  expect(models.length).toBeGreaterThan(0)
})

test("every entry has the ModelEntry shape", () => {
  for (const m of models) {
    expect(typeof m.id).toBe("string")
    expect(typeof m.name).toBe("string")
    expect(["premium", "open-source"]).toContain(m.tier)
    expect(typeof m.reasoning).toBe("boolean")
    expect(typeof m.tool_call).toBe("boolean")

    const cost = m.cost as Record<string, unknown>
    expect(typeof cost.input).toBe("number")
    expect(typeof cost.output).toBe("number")

    const limit = m.limit as Record<string, unknown>
    expect(typeof limit.context).toBe("number")
    expect(typeof limit.output).toBe("number")
    expect(limit.context as number).toBeGreaterThan(0)
  }
})

test("model ids are unique", () => {
  const ids = models.map((m) => m.id as string)
  expect(new Set(ids).size).toBe(ids.length)
})
