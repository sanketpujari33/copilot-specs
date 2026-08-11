import * as vscode from "vscode";

export function getWorkspaceUri(
  targetUri?: vscode.Uri,
): vscode.Uri | undefined {
  if (targetUri) {
    const folder = vscode.workspace.getWorkspaceFolder(targetUri);
    if (folder) {
      return folder.uri;
    }
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) {
      return folder.uri;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function getWorkspaceRoot(targetUri?: vscode.Uri): string | undefined {
  return getWorkspaceUri(targetUri)?.fsPath;
}

export function resolveWorkspacePath(
  ...segments: string[]
): vscode.Uri | undefined {
  const root = getWorkspaceUri();
  if (!root) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, ...segments);
}

export function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

export async function writeTextFile(
  uri: vscode.Uri,
  content: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

export async function ensureDir(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // Directory may already exist — ignore
  }
}

/**
 * Adds `entry` to the workspace .gitignore if not already present.
 */
export async function ensureGitignoreEntry(entry: string): Promise<void> {
  const uri = resolveWorkspacePath(".gitignore");
  if (!uri) {
    return;
  }
  let content = "";
  if (await fileExists(uri)) {
    content = await readTextFile(uri);
    const lines = content.split(/\r?\n/);
    if (lines.some((l) => l.trim() === entry)) {
      return;
    }
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeTextFile(uri, `${content}${separator}${entry}\n`);
}

export async function listDirectories(uri: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => name);
  } catch {
    return [];
  }
}

export async function listFiles(
  uri: vscode.Uri,
  extension?: string,
): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File &&
          (!extension || name.endsWith(extension)),
      )
      .map(([name]) => name);
  } catch {
    return [];
  }
}

export async function deleteRecursive(uri: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
}

export async function renameUri(
  from: vscode.Uri,
  to: vscode.Uri,
): Promise<void> {
  await vscode.workspace.fs.rename(from, to, { overwrite: false });
}

// Spec-specific path helpers — use forward slashes so these work as glob patterns on all platforms
export const GITHUB_DIR = ".github";
export const INSTRUCTIONS_DIR = ".github/instructions";
/** Specs are stored separately from instructions for clean separation of concerns. */
export const SPECS_DIR = ".github/specs";
/** @deprecated Use SPECS_DIR. Kept as an alias so all existing imports continue to work. */
export const INSTRUCTIONS_SPECS_DIR = SPECS_DIR;
export const SKILLS_DIR = ".github/skills";
export const HOOKS_DIR = ".github/hooks";
export const PROMPTS_DIR = ".github/prompts";
export const WORKFLOWS_DIR = ".github/workflows";
export const AGENTS_DIR = ".github/agents";
export const STEERING_DIR = ".github/steering";
export const COPILOT_INSTRUCTIONS_FILE = ".github/copilot-instructions.md";

/**
 * List individual steering files under .github/steering/ (.md files).
 */
export async function listSteeringFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(STEERING_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File && name.endsWith(".md"),
      )
      .map(([name]) => ({
        name: name.replace(/\.md$/, ""),
        uri: vscode.Uri.joinPath(dir, name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List workflow files under .github/workflows/ (.yml, .yaml, and .md files).
 */
export async function listWorkflowFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(WORKFLOWS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File &&
          (name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".md")),
      )
      .map(([name]) => ({
        name,
        uri: vscode.Uri.joinPath(dir, name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List agent files under .github/agents/.
 */
export async function listAgentFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(AGENTS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }

  const agentsByPath = new Map<string, { name: string; uri: vscode.Uri }>();

  // 1) Nested AGENT.md: .github/agents/<agent-name>/AGENT.md
  try {
    const nestedAgentFiles = await vscode.workspace.findFiles(
      `${AGENTS_DIR}/**/AGENT.md`,
    );
    for (const uri of nestedAgentFiles) {
      const parts = uri.path.split("/");
      const agentDir = parts.length >= 2 ? parts[parts.length - 2] : "agent";
      agentsByPath.set(uri.toString(), { name: agentDir, uri });
    }
  } catch {}

  // 2) Top-level .agent.md or .md files in .github/agents/
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      if (
        type === vscode.FileType.File &&
        (name.endsWith(".agent.md") || name.endsWith(".md"))
      ) {
        const uri = vscode.Uri.joinPath(dir, name);
        agentsByPath.set(uri.toString(), {
          name: name.replace(/(\.agent)?\.md$/, ""),
          uri,
        });
      }
    }
  } catch {}

  return [...agentsByPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * List hook files under .github/hooks/.
 */
export async function listHookFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(HOOKS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(
        ([name, type]) =>
          type === vscode.FileType.File &&
          (name.endsWith(".json") ||
            name.endsWith(".sh") ||
            name.endsWith(".js")),
      )
      .map(([name]) => ({
        name: name.replace(/\.(json|sh|js)$/, ""),
        uri: vscode.Uri.joinPath(dir, name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List top-level instruction/rules files under .github/instructions/ (excludes specs subdir).
 */
export async function listInstructionRulesFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(INSTRUCTIONS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }
  const entries = await vscode.workspace.fs.readDirectory(dir);
  return entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File && name.endsWith(".instructions.md"),
    )
    .map(([name]) => ({
      name: name.replace(/\.instructions\.md$/, ""),
      uri: vscode.Uri.joinPath(dir, name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List all skill files under .github/skills/.
 */
export async function listSkillFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(SKILLS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }

  const skillsByPath = new Map<string, { name: string; uri: vscode.Uri }>();

  // 1) Standard Copilot skill layout: .github/skills/<skill-name>/SKILL.md
  const nestedSkillFiles = await vscode.workspace.findFiles(
    `${SKILLS_DIR}/**/SKILL.md`,
  );
  for (const uri of nestedSkillFiles) {
    const parts = uri.path.split("/");
    const skillDir = parts.length >= 2 ? parts[parts.length - 2] : "skill";
    skillsByPath.set(uri.toString(), { name: skillDir, uri });
  }

  // 2) Fallback: top-level markdown skills in .github/skills/*.md
  const entries = await vscode.workspace.fs.readDirectory(dir);
  for (const [name, type] of entries) {
    if (type === vscode.FileType.File && name.endsWith(".md")) {
      const uri = vscode.Uri.joinPath(dir, name);
      skillsByPath.set(uri.toString(), {
        name: name.replace(/\.md$/, ""),
        uri,
      });
    }
  }

  return [...skillsByPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * List prompt files under .github/prompts/ (top-level .prompt.md files only,
 * excludes the specs/ subdirectory).
 */
export async function listPromptFiles(): Promise<
  { name: string; uri: vscode.Uri }[]
> {
  const dir = resolveWorkspacePath(PROMPTS_DIR);
  if (!dir || !(await fileExists(dir))) {
    return [];
  }
  const entries = await vscode.workspace.fs.readDirectory(dir);
  return entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File && name.endsWith(".prompt.md"),
    )
    .map(([name]) => ({
      name: name.replace(/\.prompt\.md$/, ""),
      uri: vscode.Uri.joinPath(dir, name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function specsInstructionsUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(SPECS_DIR, specName);
}

export function requirementsUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(
    SPECS_DIR,
    specName,
    "requirements.instructions.md",
  );
}

export function designUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(
    SPECS_DIR,
    specName,
    "design.instructions.md",
  );
}

export function tasksUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(
    SPECS_DIR,
    specName,
    "tasks.instructions.md",
  );
}

export function linksUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(".copilot-specs-cache", `${specName}.links.json`);
}

export function specConfigUri(specName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(
    ".copilot-specs-cache",
    `${specName}.config.json`,
  );
}

export function copilotInstructionsUri(): vscode.Uri | undefined {
  return resolveWorkspacePath(COPILOT_INSTRUCTIONS_FILE);
}

export function hookFileUri(hookName: string): vscode.Uri | undefined {
  return resolveWorkspacePath(HOOKS_DIR, `${hookName}.json`);
}
