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
| `@orplex/sdk/mcp` | MCP entry schema + search, client, gateway, dispatch lane |
| `@orplex/sdk/skills` | Skill loading, frontmatter parsing, roster rendering |
| `@orplex/sdk/plugins` | Plugin registry, hook compiler, bundle parser, library materializer |
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

## Catalogues are data, not code (0.3.0)

Earlier versions shipped the skill catalogue, the MCP server catalogue and the 40 plugin
bundles inside the package. They no longer exist here — a catalogue that changes weekly
does not belong in a versioned library. The SDK keeps the **shapes, the search and the
materializer**; the host supplies the entries, usually from the signed marketplace.

```ts
import { searchMcpCatalog, validateMcpCatalog, applyOAuthEnvOverrides } from "@orplex/sdk/mcp";
import { materializeBundles, listLibrary, isBundleInstalled, configureLibraryBundles } from "@orplex/sdk/plugins";

const catalog = applyOAuthEnvOverrides(await getMarketplaceMcpServers());
validateMcpCatalog(catalog);                            // throws/report on a malformed entry
searchMcpCatalog("air", "all", 20, catalog);

const bundles = materializeBundles(await getMarketplacePluginBundles());
listLibrary(bundles);                                   // rows for the Plugins page

// The hook gate runs inside tool dispatch and cannot take a parameter, so the
// host registers a provider once. Unconfigured = no library rules (fail closed).
configureLibraryBundles(async () => materializeBundles(await getMarketplacePluginBundles()));
```

Breaking changes in 0.3.0:

| Removed | Replace with |
| --- | --- |
| `SKILL_CATEGORIES`, `ALL_SKILLS` | your catalogue + `flattenSkills` / `searchSkills` / `getSkillById` |
| `MCP_CATALOG`, `MCP_CATALOG_SIZE` | your catalogue; size is `catalog.length` |
| `getMcpCatalogEntry(id)` | `getMcpCatalogEntry(id, catalog)` |
| `searchMcpCatalog(q, cat, limit)` | `searchMcpCatalog(q, cat, limit, catalog)` |
| `BUILTIN_BUNDLES` | `materializeBundles(defs)` on marketplace data |
| `materializeBundle(slug)` / `isBundleInstalled(root, slug)` / `listLibrary()` | same calls, bundle list first |
| `loadEnabledBundleRules(root)` | unchanged signature; bundles come from `configureLibraryBundles` |

`MCP_CATEGORIES` (the 14 display labels) stays: it is taxonomy, not catalogue content.

### 0.3.1

`mcpCatalogEntrySchema` now requires a transport (`stdio` or `remote`). An entry
with neither validates as an object but cannot be connected to, so it used to be
accepted and then fail at connect time. All 100 entries in the published
marketplace catalogue still validate.

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

Working and tested: the full tool surface (write/edit/read/search/exec guards), MCP client +
gateway + dispatch lane, skills, plugins, cloud client, marketplace verification, and the
agent loop.

The desktop app is fully migrated: it imports these modules from the package behind
one-line re-export shims, and reads skills, MCP servers and plugin bundles from the signed
marketplace instead of shipping them.

## License

Custom License
