import { Context, Effect, Schema } from "effect"
import { definePackage } from "./package"
import { asyncTool } from "./tool"
import { TaskExecution } from "./task"

export class AgentRunner extends Context.Service<AgentRunner, {
  readonly run: (message: string, task: typeof TaskExecution.Service) => Effect.Effect<unknown, Error>
}>()("tardigrade/experimental/packages/AgentRunner") {}

// agents exposes child-agent execution as a background package method.
export function agents() {
  return definePackage({
    name: "agents", description: "Delegate work to child agents.",
    methods: [asyncTool({
      name: "run", description: "Start a child agent with a message. Returns a task reference; requests and results arrive in the inbox.",
      input: Schema.Struct({ message: Schema.String }),
      run: ({ message }, task) => Effect.gen(function* () {
        const runner = yield* AgentRunner
        return yield* runner.run(message, task)
      }),
    })],
  })
}
