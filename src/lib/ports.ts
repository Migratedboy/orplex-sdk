// ports — the seam between the SDK tool layer and its host.
//
// The tool dispatcher never touches Electron, Next, Prisma or a database. It
// reads and writes through this context: file I/O, the todo/question store,
// task stats, plugin hooks and the transcript buffer. A host (the Orplex app,
// a server worker, a CLI) either passes its own implementation or calls
// createToolContext() and overrides the few members it cares about.

import type { ToolContext } from "./agent/native-tools";
import type { FileOpsCounters, FileOpsFs } from "./agent/file-ops";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";

/** Node's fs promoted to the FileOpsFs shape (size-capped, no Electron bridge). */
export function createNodeFs(overrides: Partial<FileOpsFs> = {}): FileOpsFs {
  return {
    // A missing/unreadable file is a normal tool outcome, not an exception: the
    // dispatcher turns "[Error..." into a tool_result the model can act on,
    // while a rejection here would abort the whole turn.
    readFile: async (p) => {
      try {
        return await readFile(p, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        return `[Error: cannot read ${p} (${code})]`;
      }
    },
    writeFile: async (p, content) => {
      await writeFile(p, content, "utf8");
      return true;
    },
    editFile: async (p, oldText, newText) => {
      try {
        const current = await readFile(p, "utf8");
        const at = current.indexOf(oldText);
        // Refuse rather than guess: a replace on a missing needle silently
        // corrupts a file the model believes it edited.
        if (at === -1) return false;
        await writeFile(p, current.slice(0, at) + newText + current.slice(at + oldText.length), "utf8");
        return true;
      } catch {
        return false;
      }
    },
    statFile: async (p) => {
      try {
        const s = await stat(p);
        return { size: s.size };
      } catch {
        return null;
      }
    },
    directoryName: path.basename(process.cwd()),
    ...overrides,
  };
}

export function createCounters(): FileOpsCounters {
  let total = 0;
  return {
    writtenFiles: new Map<string, string>(),
    getTotalWrites: () => total,
    setTotalWrites: (n) => {
      total = n;
    },
    setFilesChanged: () => {},
    bumpStat: () => {},
  };
}

export interface ToolStore {
  todos: string[];
  completed: Set<number>;
  question: { question: string; options: string[]; allowFreeText: boolean } | null;
  answer: string | null;
}

export function createStore(initial: Partial<ToolStore> = {}): {
  state: ToolStore;
  store: ToolContext["store"];
} {
  const state: ToolStore = {
    todos: [],
    completed: new Set<number>(),
    question: null,
    answer: null,
    ...initial,
  };
  return {
    state,
    store: {
      setTodos: (items) => {
        state.todos = [...items];
        state.completed = new Set<number>();
      },
      completeTodo: (index) => {
        state.completed.add(index);
      },
      clearTodos: () => {
        state.todos = [];
        state.completed = new Set<number>();
      },
      setQuestion: (question, options, allowFreeText) => {
        state.question = { question, options, allowFreeText };
        state.answer = null;
      },
      answerQuestion: (answer) => {
        state.answer = answer;
      },
    },
  };
}

export interface CreateToolContextOptions {
  mode?: string;
  owner?: { userId?: string | null; conversationId?: string | null };
  fs?: Partial<FileOpsFs>;
  abortSignal?: AbortSignal | null;
  /** Extra context members, merged last. */
  overrides?: Partial<ToolContext>;
}

/**
 * A working ToolContext with in-memory defaults. Every member is either
 * implemented here or a deliberate no-op, so a fresh consumer can dispatch a
 * tool call in three lines instead of re-implementing fifteen functions.
 */
export function createToolContext(options: CreateToolContextOptions = {}): ToolContext {
  const { state, store } = createStore();
  let display = "";

  const context: ToolContext = {
    mode: options.mode ?? "host",
    owner: options.owner,
    readFiles: new Map<string, number>(),
    contextFiles: new Map<string, string>(),
    readResults: new Map<string, string>(),
    abortSignal: options.abortSignal ?? null,
    fs: createNodeFs(options.fs),
    counters: createCounters(),
    fileTree: [],
    fileContents: {},
    store,
    stats: { commandRun() {}, failedStep() {}, rejectedAction() {} },
    hooks: { fileWritten() {}, fileEdited() {} },
    getDisplay: () => display,
    appendDisplay: (text) => {
      display += text;
    },
    // Status lines are part of the transcript: a host with no UI still needs
    // them, otherwise a run that failed halfway looks like it did nothing.
    setStatus: (status, detail) => {
      const line = detail ? `${status}: ${detail}` : String(status);
      display += (display && !display.endsWith("\n") ? "\n" : "") + line + "\n";
    },
    replaceStatus: (line) => {
      const lines = display.split("\n");
      let replaced = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim()) {
          lines[i] = line;
          replaced = true;
          break;
        }
      }
      // Nothing to replace yet (first status of a run) — show it anyway.
      display = replaced ? lines.join("\n") : `${line}\n`;
    },
    syncDisplay: () => {},
    waitForAnswer: async (timeoutMs = 600_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.answer !== null) return state.answer;
        await new Promise((r) => setTimeout(r, 50));
      }
      return "(timed out)";
    },
    ...options.overrides,
  };

  // Expose the store state for tests and hosts that render the cards.
  (context as ToolContext & { storeState?: ToolStore }).storeState = state;
  return context;
}

/** Read a directory tree three levels deep — the default `list_files` view. */
export async function readDirectoryTree(
  root: string,
  depth = 3,
): Promise<{ path: string; type: "file" | "dir" }[]> {
  const out: { path: string; type: "file" | "dir" }[] = [];
  const walk = async (dir: string, level: number, prefix: string) => {
    if (level > depth) return;
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      out.push({ path: rel, type: isDir ? "dir" : "file" });
      if (isDir) await walk(path.join(dir, entry.name), level + 1, rel);
    }
  };
  await walk(root, 1, "");
  return out;
}