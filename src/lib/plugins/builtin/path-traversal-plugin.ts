/**
 * Path Traversal Plugin — Prevents writes outside the workspace
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "path-traversal",
  version: "1.0.0",
  description: "Prevents file writes outside the workspace directory",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

/**
 * Traversal detection for a tool-supplied path.
 *
 * This used to early-return unless `workspaceRoot` had been set — and nothing
 * in the app ever set it, so the plugin was registered, activated, enabled by
 * default, and did literally nothing. It does not need the root to recognise
 * the shapes that escape it: a `..` SEGMENT, an absolute POSIX path, a Windows
 * drive path, or a UNC path. (A filename that merely contains ".." — `a..b`
 * — is not traversal; testing the whole string for ".." blocked it.)
 */
export function isEscapingPath(filePath: string): boolean {
  let normalized = filePath.replace(/\\/g, "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    /* keep raw on decode failure */
  }
  if (normalized.startsWith("/")) return true;           // POSIX absolute
  if (/^[a-zA-Z]:\//.test(normalized)) return true;       // C:/...
  if (normalized.startsWith("//")) return true;          // //server/share
  return normalized.split("/").some((segment) => segment === "..");
}

const hooks: PluginHook[] = [{
  name: "beforeToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file" && ctx.tool !== "edit_file" && ctx.tool !== "read_file") return { continue: true };
    const filePath = (ctx.args?.path as string) || "";
    if (!filePath) return { continue: true };
    if (isEscapingPath(filePath)) {
      return { continue: false, message: `path leaves the workspace: ${filePath.slice(0, 120)}` };
    }
    return { continue: true };
  },
}];

export async function activatePathTraversal(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) {
      if (!h.has(hook.name)) h.set(hook.name, []);
      h.get(hook.name).push({ plugin: "path-traversal", handler: hook.handler });
    }
  }, async () => {});
}
