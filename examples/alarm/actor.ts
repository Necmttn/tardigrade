import { actor } from "tardie/v1/core"
import { agentMethods, infer, nativeOutput, system, tools } from "tardie/v1/agent"
import { alarm } from "tardie/v1/code"

export default actor({
  name: "tardie",
  methods: agentMethods,
  components: [
    infer(({ message }) => [
      system(`You are a friendly assistant.
Use alarms to schedule reminders. When an alarm's note arrives as a message,
respond to it without scheduling it again.`),
      tools([
        alarm({ onFired: alarm => message({ text: alarm.note }) }),
      ]),
      nativeOutput,
    ]),
  ],
})
