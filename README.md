# @orplex/sdk

The framework-free core of [Orplex Code](https://github.com/Migratedboy/orplex): the AI tool
layer, MCP gateway, skills loader, plugin registry, cloud client and a signed marketplace
resolver — extracted so it can be embedded in any agent host.

The desktop app is a shell. Everything that decides *what the agent can do* lives here.

```bash
npm install @orplex/sdk
```

Requires Node 20+. Zero framework dependencies (no Next, no React, no Prisma). `zod` and
`jszip` are the only runtime dependencies; Playwright and a Sentry SDK are optional and only
touched through dynamic `import()`.

## Subpaths

| Import | Contents |
| --- | --- |
| `@orplex/sdk/tools` | Tool definitions, `dispatchToolCall`, file ops, exec guard, risk classifier, approval store, tool chain/hooks, archive extraction, ports |
| `@orplex/sdk/mcp` | MCP catalog, client, gateway, dispatch lane |
| `@orplex/sdk/skills` | Skill loading, frontmatter parsing, roster rendering |
| `@orplex/sdk/plugins` | Plugin registry, hook compiler, bundle parser, built-in bundles |
| `@orplex/sdk/cloud` | Split-deployment API client (base URL, credentials) |
| `@orplex/sdk/marketplace` | Signed catalog fetch, verification, cache and resolution |
| `@orplex/sdk/agent` | The agent loop (turn engine) over an injected model client |

## Quickstart: dispatch a tool call

```ts
import { dispatchToolCall, createToolContext } from "@orplex/sdk/tools";

const ctx = createToolContext();
const outcome = await dispatchToolCall(
  { name: "write_file", path: "/tmp/hello.txt", content: "hello\n" },
  ctx,
);

console.log(outcome.blocked);   // false
console.log(ctx.getDisplay());  // status lines the host would render
```

`createToolContext()` fills all fifteen members of `ToolContext` with working defaults
(in-memory store, Node fs, transcript buffer). Override only what your host owns:

```ts
const ctx = createToolContext({
  mode: "server",
  owner: { userId, conversationId },
  fs: { readFile: myPagedReader, writeFile: myAuditedWriter },
  overrides: { fileContents: workspaceIndex },
});
```

## Approvals

Writes and commands pause for human approval. The store **fails closed**: a host that never
configures it gets a refusal, not a five-minute hang.

```ts
import { configureApprovals, approveRequest, rejectRequest, getPendingApprovals } from "@orplex/sdk/tools";

// A UI that renders the pending list (what the desktop app does):
configureApprovals({ mode: "poll" });
setInterval(() => render(getPendingApprovals()), 500);

// Headless / CI: decide immediately.
configureApprovals({
  mode: "callback",
  onRequest: (approval) => (approval.risk === "high" ? rejectRequest(approval.id) : approveRequest(approval.id)),
});
```

Low-risk calls are auto-approved by the risk classifier before they reach the store.

## Marketplace

The app never trusts a catalog blob. The index is Ed25519-signed over canonical JSON, and
each item carries a sha256 of its own files. Unsigned or mismatched items are dropped.

```ts
import { loadCatalog, createFileCache, DEFAULT_INDEX_URL } from "@orplex/sdk/marketplace";

const { items, source, verified } = await loadCatalog({
  appVersion: "2.4.0",
  url: DEFAULT_INDEX_URL,
  publicKey: process.env.ORPLEX_SESSION_PUBLIC_KEY, // base64url SPKI DER
  cache: createFileCache(cacheDir),
  seed: vendoredSeed, // used when the network is down and nothing verifies
  ttlMs: 12 * 60 * 60 * 1000,
});

console.log(source, verified, items.length); // "network" true 101
```

`loadCatalog` never throws and never returns untrusted items: unsigned index → cached index →
seed → empty.

## Status

Working and tested today: the full tool surface (write/edit/read/search/exec guards), MCP
client + gateway, skills, plugins, cloud client, marketplace verification.

In progress:

- the app still imports these modules directly; switching it to `@orplex/sdk/*` is the next
  step, one module at a time behind re-export shims
- the marketplace catalog is populated from the app's current built-ins
- the loop engine (`/agent`) is exported but not yet driven by a public model-client contract

## License

MIT
