export default async function commandcodePlugin() {
  return {
    auth: {
      provider: "commandcode",
      methods: [
        {
          type: "api",
          label: "API Key",
          authorize: async (inputs) => {
            const key = inputs?.key?.trim()
            if (!key) return { type: "failed" as const }
            return {
              type: "success" as const,
              key,
            }
          },
        },
      ],
      loader: async (getAuth) => {
        try {
          const auth = await getAuth()
          if (!auth) return {}
          if (auth.type === "api" && auth.key) {
            return { apiKey: auth.key }
          }
          return {}
        } catch {
          return {}
        }
      },
    },
  }
}
