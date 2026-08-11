import * as vscode from "vscode";
import { Spec, SpecConfig, SpecType, WorkflowType } from "./models/index.js";
import {
  readTextFile,
  writeTextFile,
  ensureDir,
  listDirectories,
  deleteRecursive,
  renameUri,
  fileExists,
  requirementsUri,
  designUri,
  tasksUri,
  linksUri,
  specConfigUri,
  specsInstructionsUri,
  resolveWorkspacePath,
} from "./utils/fileSystem.js";
import { parseFrontmatter } from "./utils/frontmatter.js";
import { InstructionsFrontmatter } from "./models/index.js";

import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

let _templateDir: string | undefined;

function readTemplate(filename: string): string {
  if (!_templateDir) {
    return "";
  }
  try {
    return readFileSync(join(_templateDir, filename), "utf8");
  } catch {
    return "";
  }
}

export function initTemplates(extensionPath: string): void {
  _templateDir = join(extensionPath, "src", "templates");
}

function applyTemplateVars(
  template: string,
  vars: Record<string, string>,
): string {
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

async function resolveExistingSpecFile(
  name: string,
  candidateNames: string[],
): Promise<vscode.Uri | undefined> {
  const roots = [
    resolveWorkspacePath(".github", "specs", name),
    resolveWorkspacePath(".github", "instructions", "specs", name),
    resolveWorkspacePath(".kiro", "specs", name),
    resolveWorkspacePath("specs", name),
    resolveWorkspacePath(".specs", name),
  ].filter(Boolean) as vscode.Uri[];

  for (const root of roots) {
    for (const filename of candidateNames) {
      const fileUri = vscode.Uri.joinPath(root, filename);
      if (await fileExists(fileUri)) {
        return fileUri;
      }
    }
  }

  const defaultRoot = resolveWorkspacePath(".github", "specs", name);
  return defaultRoot ? vscode.Uri.joinPath(defaultRoot, candidateNames[0]) : undefined;
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

async function readSpecConfig(name: string): Promise<SpecConfig | undefined> {
  const configUri = await resolveExistingSpecFile(name, [".config.kiro", ".config.json"]);
  if (configUri && (await fileExists(configUri))) {
    try {
      const content = await readTextFile(configUri);
      return JSON.parse(content) as SpecConfig;
    } catch {}
  }
  const cacheUri = specConfigUri(name);
  if (cacheUri && (await fileExists(cacheUri))) {
    try {
      const content = await readTextFile(cacheUri);
      return JSON.parse(content) as SpecConfig;
    } catch {}
  }
  return undefined;
}

async function writeSpecConfig(
  name: string,
  config: SpecConfig,
): Promise<void> {
  const uri = specConfigUri(name);
  if (!uri) {
    return;
  }
  // Ensure cache dir exists
  const cacheDir = resolveWorkspacePath(".copilot-specs-cache");
  if (cacheDir) {
    await ensureDir(cacheDir);
  }
  await writeTextFile(uri, JSON.stringify(config, null, 2) + "\n");
}

// ── List / Load ────────────────────────────────────────────────────────────────

export async function listSpecs(): Promise<Spec[]> {
  const roots = [
    resolveWorkspacePath(".github", "specs"),
    resolveWorkspacePath(".github", "instructions", "specs"),
    resolveWorkspacePath(".kiro", "specs"),
    resolveWorkspacePath("specs"),
    resolveWorkspacePath(".specs"),
  ].filter(Boolean) as vscode.Uri[];

  const seenNames = new Set<string>();
  const specs: Spec[] = [];

  for (const root of roots) {
    if (await fileExists(root)) {
      const specNames = await listDirectories(root);
      for (const name of specNames) {
        if (!seenNames.has(name)) {
          seenNames.add(name);
          const spec = await loadSpec(name);
          if (spec) {
            specs.push(spec);
          }
        }
      }
    }
  }

  return specs;
}

export async function loadSpec(name: string): Promise<Spec | undefined> {
  const reqUri = await resolveExistingSpecFile(name, [
    "requirements.instructions.md",
    "requirements.md",
    "bugfix-analysis.template.md",
    "bugfix-analysis.md",
  ]);
  const designUriVal = await resolveExistingSpecFile(name, [
    "design.instructions.md",
    "design.md",
    "fix-plan.template.md",
    "fix-plan.md",
  ]);
  const tasksUriVal = await resolveExistingSpecFile(name, [
    "tasks.instructions.md",
    "tasks.md",
    "implementation-tasks.instructions.md",
    "tasks-quick.template.md",
  ]);
  let linksUriVal = linksUri(name);
  if (!linksUriVal) {
    linksUriVal = resolveWorkspacePath(".copilot-specs-cache", `${name}.links.json`);
  }

  if (!reqUri || !designUriVal || !tasksUriVal || !linksUriVal) {
    return undefined;
  }

  const reqExists = await fileExists(reqUri);
  const designExists = await fileExists(designUriVal);
  const tasksExists = await fileExists(tasksUriVal);

  if (!reqExists && !designExists && !tasksExists) {
    return undefined;
  }

  // Read applyTo glob from requirements frontmatter or tasks comments
  let fileGlob = "**/*";
  try {
    if (reqExists) {
      const content = await readTextFile(reqUri);
      const { frontmatter } =
        parseFrontmatter<InstructionsFrontmatter>(content);
      if (frontmatter.applyTo) {
        fileGlob = frontmatter.applyTo;
      }
    }
    if (fileGlob === "**/*" && tasksExists) {
      const tasksContent = await readTextFile(tasksUriVal);
      const filesMatch = tasksContent.match(/<!--\s*files:\s*(.+?)\s*-->/);
      if (filesMatch) {
        fileGlob = filesMatch[1].trim();
      }
    }
  } catch {
    // Use default glob
  }

  // Read spec type / workflow type from config or cache
  const config = await readSpecConfig(name);
  const specType: SpecType = config?.specType ?? "feature";
  const workflowType: WorkflowType = config?.workflowType ?? "requirements-first";

  return {
    name,
    fileGlob,
    requirementsPath: reqUri.fsPath,
    designPath: designUriVal.fsPath,
    tasksPath: tasksUriVal.fsPath,
    linksPath: linksUriVal.fsPath,
    specType,
    workflowType,
  };
}

// ── Create ─────────────────────────────────────────────────────────────────────

export async function createSpec(
  name: string,
  fileGlob: string,
  specType: SpecType = "feature",
  workflowType: WorkflowType = "requirements-first",
): Promise<Spec> {
  const instructionsDir = specsInstructionsUri(name);

  if (!instructionsDir) {
    throw new Error("No workspace folder open");
  }

  await ensureDir(instructionsDir);

  const reqUri = requirementsUri(name);
  const destDesignUri = designUri(name);
  const tasksUriVal = tasksUri(name);

  if (!reqUri || !destDesignUri || !tasksUriVal) {
    throw new Error("Could not resolve spec URIs");
  }

  const vars = { SPEC_NAME: name, FILE_GLOB: fileGlob };

  // Choose templates based on spec type
  let reqTemplate: string;
  let designTemplate: string;

  if (specType === "bugfix") {
    reqTemplate = applyTemplateVars(
      readTemplate("bugfix-analysis.template.md"),
      vars,
    );
    designTemplate = applyTemplateVars(
      readTemplate("fix-plan.template.md"),
      vars,
    );
  } else {
    reqTemplate = applyTemplateVars(
      readTemplate("requirements.template.md"),
      vars,
    );
    designTemplate = applyTemplateVars(
      readTemplate("design.template.md"),
      vars,
    );
  }

  const tasksTemplate = applyTemplateVars(
    specType === "quick"
      ? readTemplate("tasks-quick.template.md")
      : readTemplate("tasks.template.md"),
    vars,
  );

  await writeTextFile(reqUri, reqTemplate);
  await writeTextFile(destDesignUri, designTemplate);
  await writeTextFile(tasksUriVal, tasksTemplate);

  const linksUriVal = linksUri(name);
  if (linksUriVal && !(await fileExists(linksUriVal))) {
    const cacheDir = resolveWorkspacePath(".copilot-specs-cache");
    if (cacheDir) {
      await ensureDir(cacheDir);
    }
    await writeTextFile(linksUriVal, "{}");
  }

  // Write .copilot-specs-cache config
  const specConfig: SpecConfig = {
    specId: randomUUID(),
    specType,
    workflowType,
    createdAt: new Date().toISOString(),
  };
  await writeSpecConfig(name, specConfig);

  return (await loadSpec(name))!;
}

// ── Delete / Rename ────────────────────────────────────────────────────────────

export async function deleteSpec(name: string): Promise<void> {
  const instructionsDir = specsInstructionsUri(name);

  if (instructionsDir && (await fileExists(instructionsDir))) {
    await deleteRecursive(instructionsDir);
  }

  // Also clean up cache entries
  const configUri = specConfigUri(name);
  if (configUri && (await fileExists(configUri))) {
    await deleteRecursive(configUri);
  }
  const linksUriVal = linksUri(name);
  if (linksUriVal && (await fileExists(linksUriVal))) {
    await deleteRecursive(linksUriVal);
  }
}

export async function renameSpec(
  oldName: string,
  newName: string,
): Promise<void> {
  const oldInstructionsDir = specsInstructionsUri(oldName);
  const newInstructionsDir = specsInstructionsUri(newName);

  if (oldInstructionsDir && newInstructionsDir) {
    await renameUri(oldInstructionsDir, newInstructionsDir);
  }

  // Migrate cache files
  const oldConfigUri = specConfigUri(oldName);
  const newConfigUri = specConfigUri(newName);
  if (
    oldConfigUri &&
    newConfigUri &&
    (await fileExists(oldConfigUri))
  ) {
    await renameUri(oldConfigUri, newConfigUri);
  }
  const oldLinksUri = linksUri(oldName);
  const newLinksUri = linksUri(newName);
  if (oldLinksUri && newLinksUri && (await fileExists(oldLinksUri))) {
    await renameUri(oldLinksUri, newLinksUri);
  }
}

// ── Prompt (UI) ────────────────────────────────────────────────────────────────

export async function promptCreateSpec(): Promise<Spec | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Spec name (e.g. "auth", "user-profile")',
    placeHolder: "feature-name",
    validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
  });
  if (!name) {
    return undefined;
  }

  // Ask for spec type
  const specTypePick = await vscode.window.showQuickPick(
    [
      {
        label: "$(sparkle) Feature Spec",
        description: "New feature — requirements → design → tasks",
        value: "feature" as SpecType,
      },
      {
        label: "$(bug) Bugfix Spec",
        description: "Bug fix — root cause analysis → fix plan → tasks",
        value: "bugfix" as SpecType,
      },
      {
        label: "$(zap) Quick Spec",
        description: "Fast-track — all three files in one pass",
        value: "quick" as SpecType,
      },
    ],
    { placeHolder: "Choose spec type" },
  );
  if (!specTypePick) {
    return undefined;
  }
  const specType = specTypePick.value;

  // For feature specs, ask about workflow type
  let workflowType: WorkflowType = "requirements-first";
  if (specType === "feature") {
    const workflowPick = await vscode.window.showQuickPick(
      [
        {
          label: "$(list-ordered) Requirements-First",
          description: "Write requirements, then design, then tasks",
          value: "requirements-first" as WorkflowType,
        },
        {
          label: "$(symbol-structure) Design-First",
          description: "Start with technical design, derive requirements",
          value: "tech-design-first" as WorkflowType,
        },
      ],
      { placeHolder: "Choose workflow type" },
    );
    if (!workflowPick) {
      return undefined;
    }
    workflowType = workflowPick.value;
  } else if (specType === "quick") {
    workflowType = "quick";
  }

  const fileGlob = await vscode.window.showInputBox({
    prompt:
      "File glob pattern for this spec (Copilot will auto-attach instructions to matching files)",
    placeHolder: "src/auth/**",
    value: `src/${name.toLowerCase()}/**`,
  });
  if (fileGlob === undefined) {
    return undefined;
  }

  const spec = await createSpec(
    name.trim(),
    fileGlob.trim() || "**/*",
    specType,
    workflowType,
  );

  return spec;
}

export async function promptCreateBugfixSpec(): Promise<Spec | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Bug title / issue name (e.g. "fix-login-redirect", "null-pointer-auth")',
    placeHolder: "bugfix-name",
    validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
  });
  if (!name) {
    return undefined;
  }
  const fileGlob = await vscode.window.showInputBox({
    prompt: "File glob pattern for this bugfix spec",
    placeHolder: "src/auth/**",
    value: `src/${name.toLowerCase()}/**`,
  });
  if (fileGlob === undefined) {
    return undefined;
  }
  return await createSpec(
    name.trim(),
    fileGlob.trim() || "**/*",
    "bugfix",
    "requirements-first",
  );
}

export async function promptCreateQuickSpec(): Promise<Spec | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Quick spec name (e.g. "refactor-helpers", "add-logging")',
    placeHolder: "quick-spec-name",
    validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
  });
  if (!name) {
    return undefined;
  }
  const fileGlob = await vscode.window.showInputBox({
    prompt: "File glob pattern for this quick spec",
    placeHolder: "src/**",
    value: `src/${name.toLowerCase()}/**`,
  });
  if (fileGlob === undefined) {
    return undefined;
  }
  return await createSpec(
    name.trim(),
    fileGlob.trim() || "**/*",
    "quick",
    "quick",
  );
}

export async function promptCreateSpecWizard(): Promise<Spec | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(sparkle) Feature Spec",
        description: "New feature — requirements → design → tasks",
        value: "feature",
      },
      {
        label: "$(bug) Bugfix Spec",
        description: "Bug fix — root cause analysis → fix plan → tasks",
        value: "bugfix",
      },
      {
        label: "$(zap) Quick Spec",
        description: "Fast-track task checklist in one pass",
        value: "quick",
      },
    ],
    { placeHolder: "Select Spec Generator Wizard" },
  );
  if (!pick) {
    return undefined;
  }
  if (pick.value === "bugfix") {
    return promptCreateBugfixSpec();
  } else if (pick.value === "quick") {
    return promptCreateQuickSpec();
  } else {
    return promptCreateSpec();
  }
}

