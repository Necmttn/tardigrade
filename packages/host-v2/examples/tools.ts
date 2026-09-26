import { Effect, Schema } from "effect"
import { tool } from "@clavia/tardigrade-agent-v2"

export const exampleTools = [
  tool({
    name: "add",
    description: "Add two numbers.",
    input: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    run: ({ a, b }) => Effect.succeed(a + b),
  }),
  tool({
    name: "fetch",
    description: "Fetch an HTTP or HTTPS URL with GET and return its status and text body.",
    input: Schema.Struct({ url: Schema.String }),
    run: ({ url }) => Effect.tryPromise({
      try: async signal => {
        const target = new URL(url)
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("fetch requires an HTTP or HTTPS URL")
        const response = await fetch(target, { signal })
        return { url: response.url, status: response.status, ok: response.ok, body: await response.text() }
      },
      catch: error => error instanceof Error ? error : new Error(String(error)),
    }),
  }),
]
