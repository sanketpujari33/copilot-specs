import * as vscode from "vscode";
import * as path from "node:path";
import {
  readTextFile,
  writeTextFile,
  fileExists,
  ensureDir,
  copilotInstructionsUri,
  resolveWorkspacePath,
  listInstructionRulesFiles,
  listSkillFiles,
  listPromptFiles,
  listAgentFiles,
  listHookFiles,
  listWorkflowFiles,
  PROMPTS_DIR,
  AGENTS_DIR,
  HOOKS_DIR,
  WORKFLOWS_DIR,
} from "./utils/fileSystem.js";

const STEERING_START = "<!-- copilot-specs:steering:start -->";
const STEERING_END = "<!-- copilot-specs:steering:end -->";
type NewSteeringKind =
  | "rules"
  | "skill"
  | "prompt"
  | "workflow"
  | "agent"
  | "hook";

export interface SteeringData {
  name: string;
  filePath: string;
  content: string;
}

export async function readAllSteering(): Promise<SteeringData[]> {
  const uri = copilotInstructionsUri();
  if (!uri || !(await fileExists(uri))) {
    return [];
  }

  const content = await readTextFile(uri);
  const startIdx = content.indexOf(STEERING_START);
  const endIdx = content.indexOf(STEERING_END);

  if (startIdx === -1 || endIdx === -1) {
    return [];
  }

  const managed = content
    .slice(startIdx + STEERING_START.length, endIdx)
    .trim();
  const entries: SteeringData[] = [];

  // Parse named sections: ## name\n...(until next ## or end)
  const sectionRegex = /^## (.+?)$([\s\S]*?)(?=^## |\s*$)/gm;
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(managed)) !== null) {
    entries.push({
      name: match[1].trim(),
      filePath: uri.fsPath,
      content: match[2].trim(),
    });
  }

  return entries;
}

export async function saveSteeringData(
  entries: SteeringData[],
): Promise<void> {
  const uri = copilotInstructionsUri();
  if (!uri) {
    return;
  }

  let content = "";
  if (await fileExists(uri)) {
    content = await readTextFile(uri);
  } else {
    content = `# Copilot Instructions\n\n${STEERING_START}\n\n${STEERING_END}\n`;
  }

  const sectionsText = entries
    .map((e) => `## ${e.name}\n\n${e.content}`)
    .join("\n\n");
  const managedContent = `${STEERING_START}\n\n${sectionsText}\n\n${STEERING_END}`;

  const startIdx = content.indexOf(STEERING_START);
  const endIdx = content.indexOf(STEERING_END);

  let fileContent: string;
  if (startIdx !== -1 && endIdx !== -1) {
    fileContent =
      content.slice(0, startIdx) +
      managedContent +
      content.slice(endIdx + STEERING_END.length);
  } else {
    fileContent = content.trimEnd() + "\n\n" + managedContent + "\n";
  }

  await writeTextFile(uri, fileContent);
}

export async function appendSteeringEntry(
  name: string,
  content: string,
): Promise<void> {
  const uri = copilotInstructionsUri();
  if (!uri) {
    throw new Error("No workspace folder open");
  }

  // Ensure .github dir exists
  const githubDir = resolveWorkspacePath(".github");
  if (githubDir) {
    await ensureDir(githubDir);
  }

  let fileContent = "";
  if (await fileExists(uri)) {
    fileContent = await readTextFile(uri);
  }

  const newEntry = `\n## ${name}\n\n${content}\n`;

  if (fileContent.includes(STEERING_START)) {
    // Insert before end marker
    fileContent = fileContent.replace(
      STEERING_END,
      `${newEntry}${STEERING_END}`,
    );
  } else {
    // Append managed section to end of file
    fileContent += `\n\n${STEERING_START}\n${newEntry}\n${STEERING_END}\n`;
  }

  await writeTextFile(uri, fileContent);
}

export async function readSteeringForContext(): Promise<string> {
  const parts: string[] = [];
  const readPaths = new Set<string>();

  // 1. copilot-instructions.md / AGENTS.md
  const potentialInstructions = [
    copilotInstructionsUri(),
    resolveWorkspacePath(".github", "AGENTS.md"),
    resolveWorkspacePath("AGENTS.md"),
  ];

  for (const uri of potentialInstructions) {
    if (uri && (await fileExists(uri)) && !readPaths.has(uri.fsPath)) {
      readPaths.add(uri.fsPath);
      try {
        const text = await readTextFile(uri);
        if (text.trim()) {
          parts.push(`### ${path.basename(uri.fsPath)}\n${text.trim()}`);
        }
      } catch {}
    }
  }

  // 1b. Individual steering files (.github/steering/*.md)
  try {
    const { listSteeringFiles } = await import("./utils/fileSystem.js");
    const steeringFiles = await listSteeringFiles();
    for (const sf of steeringFiles) {
      if (sf.uri && (await fileExists(sf.uri)) && !readPaths.has(sf.uri.fsPath)) {
        readPaths.add(sf.uri.fsPath);
        const text = await readTextFile(sf.uri);
        if (text.trim()) {
          parts.push(`### Steering: ${sf.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 2. Instruction rules (.github/instructions/*.instructions.md)
  try {
    const rules = await listInstructionRulesFiles();
    for (const rule of rules) {
      if (rule.uri && (await fileExists(rule.uri)) && !readPaths.has(rule.uri.fsPath)) {
        readPaths.add(rule.uri.fsPath);
        const text = await readTextFile(rule.uri);
        if (text.trim()) {
          parts.push(`### Rule: ${rule.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 3. Skills (.github/skills/*/SKILL.md)
  try {
    const skills = await listSkillFiles();
    for (const skill of skills) {
      if (skill.uri && (await fileExists(skill.uri)) && !readPaths.has(skill.uri.fsPath)) {
        readPaths.add(skill.uri.fsPath);
        const text = await readTextFile(skill.uri);
        if (text.trim()) {
          parts.push(`### Skill: ${skill.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 4. Prompts (.github/prompts/*.prompt.md)
  try {
    const prompts = await listPromptFiles();
    for (const prompt of prompts) {
      if (prompt.uri && (await fileExists(prompt.uri)) && !readPaths.has(prompt.uri.fsPath)) {
        readPaths.add(prompt.uri.fsPath);
        const text = await readTextFile(prompt.uri);
        if (text.trim()) {
          parts.push(`### Prompt: ${prompt.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 5. Agents (.github/agents/*.agent.md or AGENT.md)
  try {
    const agents = await listAgentFiles();
    for (const agent of agents) {
      if (agent.uri && (await fileExists(agent.uri)) && !readPaths.has(agent.uri.fsPath)) {
        readPaths.add(agent.uri.fsPath);
        const text = await readTextFile(agent.uri);
        if (text.trim()) {
          parts.push(`### Agent: ${agent.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 6. Hooks (.github/hooks/*.json)
  try {
    const hooks = await listHookFiles();
    for (const hook of hooks) {
      if (hook.uri && (await fileExists(hook.uri)) && !readPaths.has(hook.uri.fsPath)) {
        readPaths.add(hook.uri.fsPath);
        const text = await readTextFile(hook.uri);
        if (text.trim()) {
          parts.push(`### Hook: ${hook.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  // 7. Workflows (.github/workflows/*.yml)
  try {
    const workflows = await listWorkflowFiles();
    for (const wf of workflows) {
      if (wf.uri && (await fileExists(wf.uri)) && !readPaths.has(wf.uri.fsPath)) {
        readPaths.add(wf.uri.fsPath);
        const text = await readTextFile(wf.uri);
        if (text.trim()) {
          parts.push(`### Workflow: ${wf.name}\n${text.trim()}`);
        }
      }
    }
  } catch {}

  return parts.join("\n\n---\n\n");
}

export async function getPlanAgentsContext(): Promise<string> {
  const planParts: string[] = [];
  try {
    const agents = await listAgentFiles();
    for (const agent of agents) {
      if (agent.uri && (await fileExists(agent.uri))) {
        const text = await readTextFile(agent.uri);
        if (text.trim()) {
          planParts.push(`### Plan Agent (${agent.name}):\n${text.trim()}`);
        }
      }
    }
  } catch {}

  return planParts.join("\n\n---\n\n");
}

export async function promptNewSteering(
  defaultKind?: NewSteeringKind,
): Promise<void> {
  const kind = defaultKind
    ? { value: defaultKind }
    : await vscode.window.showQuickPick(
        [
          {
            label: "$(symbol-ruler) Rules file",
            description: "New .instructions.md file in .github/instructions/",
            value: "rules" as const,
          },
          {
            label: "$(sparkle) Skill",
            description: "New SKILL.md entry in .github/skills/",
            value: "skill" as const,
          },
          {
            label: "$(comment-discussion) Prompt",
            description: "New .prompt.md file in .github/prompts/",
            value: "prompt" as const,
          },
          {
            label: "$(workflow) Workflow",
            description: "New workflow file in .github/workflows/",
            value: "workflow" as const,
          },
          {
            label: "$(person) Agent",
            description: "New .agent.md file in .github/agents/",
            value: "agent" as const,
          },
          {
            label: "$(plug) Hook",
            description: "New hook JSON configuration in .github/hooks/",
            value: "hook" as const,
          },
        ],
        { placeHolder: "What do you want to add?" },
      );
  if (!kind) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt:
      kind.value === "rules"
        ? "Rules file name (without extension)"
        : kind.value === "skill"
          ? "Skill name"
          : kind.value === "workflow"
            ? "Workflow name (e.g. ci, test-runner)"
            : kind.value === "agent"
              ? "Agent name"
              : kind.value === "hook"
                ? "Hook name"
                : "Prompt name (without extension)",
    placeHolder:
      kind.value === "rules"
        ? 'e.g., "testing", "deployment"'
        : kind.value === "skill"
          ? 'e.g., "test-runner", "linter"'
          : kind.value === "workflow"
            ? 'e.g., "ci", "copilot-agent-workflow"'
            : kind.value === "agent"
              ? 'e.g., "architect", "reviewer"'
              : kind.value === "hook"
                ? 'e.g., "on-task-start", "verify-build"'
                : 'e.g., "review-pr", "summarize-diff"',
  });
  if (!name?.trim()) {
    return;
  }

  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  const workspaceUri = resolveWorkspacePath(".");
  if (!workspaceUri) {
    vscode.window.showWarningMessage("No workspace folder open.");
    return;
  }

  if (kind.value === "rules") {
    const dir = resolveWorkspacePath(".github/instructions");
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(
      `.github/instructions/${slug}.instructions.md`,
    );
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(
        `Rules file "${slug}.instructions.md" already exists.`,
      );
    } else {
      await writeTextFile(
        uri,
        `---\napplyTo: "**"\n---\n\n# ${name.trim()}\n\n> Add your instructions here.\n`,
      );
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } else if (kind.value === "skill") {
    const dir = resolveWorkspacePath(`.github/skills/${slug}`);
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(`.github/skills/${slug}/SKILL.md`);
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(`Skill "${slug}" already exists.`);
    } else {
      await writeTextFile(
        uri,
        `---\nname: ${slug}\ndescription: Describe what this skill does and when Copilot should use it.\n---\n`,
      );
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } else if (kind.value === "agent") {
    const dir = resolveWorkspacePath(AGENTS_DIR);
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(`${AGENTS_DIR}/${slug}.agent.md`);
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(
        `Agent file "${slug}.agent.md" already exists.`,
      );
    } else {
      await writeTextFile(
        uri,
        `---\nname: ${slug}\ndescription: Describe the specialized agent instructions.\ntools: []\n---\n\n# ${name.trim()} Agent\n\n> Define guidelines and behaviors for this agent.\n`,
      );
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } else if (kind.value === "hook") {
    const dir = resolveWorkspacePath(HOOKS_DIR);
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(`${HOOKS_DIR}/${slug}.json`);
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(
        `Hook file "${slug}.json" already exists.`,
      );
    } else {
      const hookContent = JSON.stringify(
        {
          name: slug,
          description: `Custom hook for ${name.trim()}`,
          events: ["onTaskStart", "onTaskComplete"],
          action: "vscode.commands.executeCommand",
          command: "workbench.action.tasks.runTask",
        },
        null,
        2,
      );
      await writeTextFile(uri, hookContent);
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } else if (kind.value === "workflow") {
    const dir = resolveWorkspacePath(WORKFLOWS_DIR);
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(`${WORKFLOWS_DIR}/${slug}.yml`);
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(
        `Workflow file "${slug}.yml" already exists.`,
      );
    } else {
      const template = [
        `name: ${name.trim()}`,
        `on:`,
        `  push:`,
        `    branches: [ main, master ]`,
        `  pull_request:`,
        `    branches: [ main, master ]`,
        ``,
        `jobs:`,
        `  build-and-test:`,
        `    runs-on: ubuntu-latest`,
        `    steps:`,
        `      - uses: actions/checkout@v4`,
        `      - name: Setup Node.js`,
        `        uses: actions/setup-node@v4`,
        `        with:`,
        `          node-version: 20`,
        `      - name: Install dependencies`,
        `        run: npm ci`,
        `      - name: Run tests`,
        `        run: npm test`,
        ``,
      ].join("\n");
      await writeTextFile(uri, template);
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } else {
    const dir = resolveWorkspacePath(PROMPTS_DIR);
    if (dir) {
      await ensureDir(dir);
    }
    const uri = resolveWorkspacePath(`${PROMPTS_DIR}/${slug}.prompt.md`);
    if (!uri) {
      return;
    }
    if (await fileExists(uri)) {
      vscode.window.showWarningMessage(
        `Prompt "${slug}.prompt.md" already exists.`,
      );
    } else {
      await writeTextFile(
        uri,
        `---\nagent: "agent"\n---\n\n# ${name.trim()}\n\n> Describe when and how this prompt should be used.\n`,
      );
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  }
}

export async function openSteeringFile(): Promise<void> {
  const uri = copilotInstructionsUri();
  if (!uri) {
    vscode.window.showWarningMessage("No workspace folder open.");
    return;
  }
  if (!(await fileExists(uri))) {
    await writeTextFile(
      uri,
      `# Copilot Instructions\n\n${STEERING_START}\n\n${STEERING_END}\n`,
    );
  }
  await vscode.commands.executeCommand("vscode.open", uri);
}
