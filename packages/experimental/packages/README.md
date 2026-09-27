# Packages

Packages supply method definitions shared by direct tools and code execution. It depends on Effect and has no dependency on an actor, host, event log, or ports. definePackage groups a name, description, and validated methods. packageTools exposes those methods with package__method names. Each method owns its sync or async execution mode; async methods require TaskRuntime.

workspace() exposes read, write, and list over the Workspace service. memoryWorkspace supplies ephemeral storage; applications can supply durable implementations. Read and listing limits are exported in DEFAULT_WORKSPACE_POLICY, accept overrides, and appear in descriptions and truncation metadata. Read offsets and listing cursors allow callers to retrieve subsequent portions.

fetchPackage() exposes fetch.get({ url }) for HTTP and HTTPS and returns the complete response body. A fetch implementation can be supplied explicitly. Fetch always uses sync execution, returning its result before the calling tool completes.

agents() exposes agents.run({ message }) as an async method. AgentRunner supplies child execution; TaskRuntime starts the task and TaskExecution carries progress and correlated permission or budget requests.

The shared collection in [agent/src/agent.ts](../agent/src/agent.ts) includes fetch, alarm, workspace, and agents. Service Layers supply implementations independently of the definitions.

alarm() exposes set_alarm and cancel_alarm as synchronous methods through AlarmScheduler. Setting an alarm records its identity, deadline, and message, then returns immediately. The host observes the alarm atom to maintain the next wake-up. AlarmSet, AlarmCancelled, and AlarmRang describe its lifecycle.
