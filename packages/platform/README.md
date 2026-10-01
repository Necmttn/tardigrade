# Platform adapters

Platform layers supply storage, transport, and isolation for the atom runtime.

```text
src/
├── bun/                   SQLite, local promises, isolates
├── cloudflare/            Durable Object storage and RPC
└── shared/
    ├── worker-loader/     loaded Worker isolates
    ├── sql-journal.ts     journal and checkpoint persistence
    ├── http.ts            actor HTTP routes
    ├── http-message.ts    HTTP delivery transport
    └── rpc-message.ts     actor RPC delivery transport
```

Worker Loader is exported through the `worker-loader/*` subpath. Its binding depends on the component code execution contract in `packages/deprecated/code`.
