type Job = { key: string; text: string }
type Environment = {
  JOBS: { send(job: Job): Promise<void> }
  JOB_TEXT: string
  TARDIGRADE_MESSAGE_URL: string
  TARDIGRADE_TOKEN: string
}
type Batch = { messages: Array<{ body: Job; ack(): void; retry(): void }> }

export default {
  fetch() { return Response.json({ prototype: true, role: "scheduled-agent-delivery" }) },
  async scheduled(controller: { cron: string; scheduledTime: number }, env: Environment) {
    await env.JOBS.send({ key: `cron:${controller.cron}:${controller.scheduledTime}`, text: env.JOB_TEXT })
  },
  async queue(batch: Batch, env: Environment) {
    for (const message of batch.messages) {
      try {
        const response = await fetch(env.TARDIGRADE_MESSAGE_URL, {
          method: "POST", redirect: "error",
          headers: {
            authorization: `Bearer ${env.TARDIGRADE_TOKEN}`,
            "content-type": "application/json", "idempotency-key": message.body.key,
          },
          body: JSON.stringify({ text: message.body.text }),
        })
        await response.body?.cancel()
        if (response.status !== 202) throw new Error(`Delivery returned ${response.status}`)
        message.ack()
      } catch {
        message.retry()
      }
    }
  },
}
