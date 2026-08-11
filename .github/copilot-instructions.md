# Copilot Instructions — copilot-specs

This is a **VS Code extension** (TypeScript, Node 18, ES2022) that manages specification-driven development workflows inside VS Code. Use these instructions when contributing to or reasoning about this codebase.

---

## Architecture Overview

```
src/extension.ts          ← Composition root. Wires all providers, commands,
                            file-system watchers, and the chat participant.
src/specManager.ts        ← Spec CRUD: create/list/load/delete/rename specs.
                            Reads templates via node:fs readFileSync.
src/taskManager.ts        ← Markdown task parser + completion toggler.
src/codeLensProvider.ts   ← CodeLens for source files, task docs, requirement docs.
                            Caches task↔file links in .copilot-specs-cache/.
src/specProvider.ts       ← TreeDataProviders (SpecProvider, SteeringProvider
                            with Instructions/Rules/Skills/Prompts sections,
                            HooksProvider, MCPServersProvider).
src/statusBar.ts          ← SpecStatusBar showing active-spec task progress.
src/webview/specPanel.ts  ← Full webview panel for spec editing/display.
src/copilot/
  chatParticipant.ts      ← @spec create / regenerate chat participant.
  specGenerator.ts        ← vscode.lm gpt-4o content generation.
src/autopilot.ts          ← Parses FILE: blocks from model output; applies
                            changes via WorkspaceEdit.
src/steeringManager.ts    ← Managed sections in .github/copilot-instructions.md.
src/hooksManager.ts       ← .github/hooks/*.json management.
src/mcpManager.ts         ← MCP server discovery + toggling (JSONC parsing).
src/models/index.ts       ← All shared TypeScript interfaces.
src/utils/fileSystem.ts   ← All vscode.workspace.fs wrappers + path constants.
src/utils/frontmatter.ts  ← YAML frontmatter parse/serialize/strip (js-yaml).
```

**Data flow**: `specManager` creates/loads spec files → `taskManager` parses tasks → `codeLensProvider` links tasks to implementation files (cache in `.copilot-specs-cache/`) → `statusBar` renders progress.

---

## Spec Storage Layout & Auto-Creation Workflow

```
.github/instructions/specs/<name>/
  requirements.instructions.md       ← REQ-xx IDs in frontmatter/body
  design.instructions.md             ← Architecture + integration decisions
  implementation-tasks.instructions.md  ← Task list with <!-- task:Tn --> markers
.copilot-specs-cache/<name>.links.json  ← SpecLinks: { [taskId]: string[] }
.github/hooks/*.json                    ← HooksFileConfig (HookEventName → Hook[])
.github/copilot-instructions.md         ← Steering; managed sections use markers
```

Frontmatter fields (YAML): `name`, `applyTo`, `description`.

---

## On-Click & Automated Spec Generation Protocol

When an On-Click event occurs (e.g., clicking **New Spec** in the tree view, clicking **Start Task** CodeLens, or invoking `@spec /create <name>`):

1. **Auto Folder & File Scaffolding**:
   - Automatically creates directory `.github/instructions/specs/<spec-name>/`.
   - Populates three standard scaffold files from templates: `requirements.instructions.md`, `design.instructions.md`, and `implementation-tasks.instructions.md`.
   - Initializes empty task links cache at `.copilot-specs-cache/<spec-name>.links.json`.

2. **Copilot AI Auto-Generation Rules**:
   - **Requirements Generation**: Must define user stories, functional criteria, and assign REQ-xx identifiers.
   - **Design Generation**: Must describe target architecture, data models, and component boundaries.
   - **Tasks Generation**: Must emit markdown checkboxes with HTML task markers (`- [ ] <!-- task:T1 --> Task title <!-- requires:REQ-01 -->`).

3. **Auto-Trigger Agent Execution**:
   - Clicking **Start Task** in CodeLens opens an agent-mode prompt pre-populated with requirement context, steering rules, and target task.
   - Clicking **Verify All Tasks with Copilot** initiates spec-wide verification against active workspace code.

---

## Task & Requirements Conventions

- Task IDs are embedded as HTML comments: `<!-- task:T1 -->` or bold: `**T1**`
- Requirement links: `<!-- requires:REQ-01 -->`
- Full task line format:
  ```markdown
  - [ ] <!-- task:T1 --> Title <!-- requires:REQ-01 -->
  ```
- `taskManager.ts` uses these exact regex patterns — do not change the comment syntax.
- Auto-linking triggers 1200 ms after any change to `implementation-tasks.instructions.md` or any implementation file (`.ts`, `.js`, `.py`, `.go`, etc.). It skips `.git/`, `node_modules/`, `dist/`, `.github/`.

---

## File System Rules

- **All workspace FS operations must go through `src/utils/fileSystem.ts`** which wraps `vscode.workspace.fs`. Never use `node:fs` inside `src/` except in `specManager.ts` and `mcpManager.ts` (template loading / JSONC config reading).
- Path constants live in `fileSystem.ts`:
  - `INSTRUCTIONS_SPECS_DIR = ".github/instructions/specs"`
  - `HOOKS_DIR = ".github/hooks"`
  - `COPILOT_INSTRUCTIONS_FILE = ".github/copilot-instructions.md"`
- `TextEncoder` / `TextDecoder` (from `@types/node`) are used for byte buffers — do not add `Buffer` polyfills.

---

## Steering (copilot-instructions.md) Sections

Managed blocks use sentinel comments:

```markdown
<!-- copilot-specs:steering:start -->

...content managed by steeringManager...

<!-- copilot-specs:steering:end -->
```

Do not remove or reorder these markers. `steeringManager.ts` replaces content between them programmatically.

---

## Autopilot FILE Blocks

When `specGenerator.ts` or the autopilot runs, model output must produce changes using `FILE:` blocks:

````
FILE: src/example.ts
```typescript
// full file content
````

````
`autopilot.ts` parses these blocks and applies them as a `vscode.WorkspaceEdit`. Do not embed partial diffs — always emit the complete file content.

---

## Build & Development

| Command | Purpose |
|---|---|
| `npm run compile` | Type-check + emit via `tsc` |
| `npm run bundle` | Production bundle via esbuild → `dist/extension.js` |
| `npm run dev` | Watch mode (esbuild `--watch`) |
| `npm run lint` | ESLint on `src/` |
| `npm test` | `@vscode/test-cli` integration tests |
| **F5** | Launch Extension Development Host in VS Code |

Build output: `dist/extension.js` (CJS, target node18, `vscode` externalized).

---

## TypeScript Conventions

- `module: "Node16"`, `target: "ES2022"`, `strict: true`, `types: ["node"]`
- **Always add `.js` extension to relative imports** (Node16 ESM resolution):
  ```typescript
  import { parseFrontmatter } from "./utils/frontmatter.js";
````

- All shared types live in `src/models/index.ts` — add new interfaces there.
- Use `vscode.lm.selectChatModels({ family: "gpt-4o" })` for LLM calls; do not hard-code model IDs.

---

## Packaging & Release

- Icon: `media/icon.png` (256×256, referenced in `package.json` as `"icon"`)
- Package: `npx @vscode/vsce package`
- Publish: triggered by `v*` tag push (see `.github/workflows/release.yml`); requires `VSCE_PAT` secret
- `CHANGELOG.md` follows Keep a Changelog format — update `[Unreleased]` on every meaningful change

---

## Agentic Core Architecture (7 Components)

The extension unifies seven agentic building blocks under GitHub Copilot:

| Component | Purpose & Workspace Location | Trigger & Integration |
|---|---|---|
| **1. Instructions & Rules** | Global coding standards & safety rules (`.github/copilot-instructions.md`, `.github/instructions/*.md`) | Always active in LLM prompt context |
| **2. Skills** | Domain-specific expert packages (`.github/skills/*/SKILL.md`) | Loaded dynamically per task domain |
| **3. Prompts** | Reusable prompt templates (`.github/prompts/*.prompt.md`) | Invoked via `/command` or chat prompts |
| **4. Workflows** | Multi-phase operational procedures (`.github/workflows/*.md`) | Followed during spec execution phases |
| **5. Tools** | Executable APIs (`src/copilot/lmTools.ts`, `src/todos/lmTools.ts`, MCP) | Autonomous LLM tool invocation |
| **6. Hooks & Actions** | Lifecycle event handlers (`.github/hooks/*.json`) | Fired on `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, etc. |
| **7. Subagents** | Delegated background workers (`.github/agents/`) | Spawned for parallel or specialized tasks |

---

## Automated TODO Engine (`src/todos/`)

- **Template Matching**: Evaluates `.todo.json` templates against workspace files using `applyTo` globs, `fileContains`, and `excludeFileContains` rules.
- **Git Branch Awareness**: `gitTodoService.ts` tracks active git branch to scope TODO instances per branch or globally.
- **File Watcher**: `fileWatcher.ts` updates active TODO tree items in real-time as workspace files change.
- **LM Tools Integration**: Registers Language Model tools (`registerTodoLMTools`) allowing Copilot agents to list, create, complete, or ignore workspace TODOs programmatically.

---

## MCP (Model Context Protocol) Discovery & Management (`src/mcpManager.ts`)

- **Discovery**: Automatically scans workspace configs (`.github/mcp.json`, `.vscode/mcp.json`, `.mcp.json`, `mcp.json`) and User profile configs (`Code/User/mcp.json`, `Code - Insiders/User/mcp.json`).
- **Parsing**: Robust JSONC parser supporting block comments, line comments, and trailing commas.
- **State Toggling**: `setMcpServerEnabled` safely enables or disables MCP servers across configuration files.

