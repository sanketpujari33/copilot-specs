import * as vscode from "vscode";
import * as path from "path";
import { listSpecs } from "./specManager.js";
import { loadTasks, markTaskAndSubtasksCompleted } from "./taskManager.js";
import { Task } from "./models/index.js";
import {
  readTextFile,
  requirementsUri,
  designUri,
  tasksUri,
  fileExists,
} from "./utils/fileSystem.js";
import { stripFrontmatter } from "./utils/frontmatter.js";
import { readSteeringForContext } from "./steeringManager.js";
import { selectBestChatModel } from "./copilot/specGenerator.js";

export async function runAutopilot(specName?: string): Promise<void> {
  let selectedSpecName = specName;
  if (!selectedSpecName) {
    const specs = await listSpecs();
    if (specs.length === 0) {
      vscode.window.showInformationMessage(
        'No specs found. Create a spec first with "Copilot Specs: New Spec".',
      );
      return;
    }

    const specPick = await vscode.window.showQuickPick(
      specs.map((s) => ({ label: s.name, description: s.fileGlob })),
      { placeHolder: "Select a spec to execute with Autopilot" },
    );
    if (!specPick) {
      return;
    }
    selectedSpecName = specPick.label;
  }

  const { tasks } = await loadTasks(selectedSpecName);
  const pending = tasks.filter((t) => !t.completed);

  if (pending.length === 0) {
    vscode.window.showInformationMessage(
      `All tasks in "${selectedSpecName}" are already complete! 🎉`,
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Autopilot will attempt to implement ${pending.length} task(s) in spec "${selectedSpecName}" using Copilot. Continue?`,
    { modal: true },
    "Run Autopilot",
  );
  if (confirmed !== "Run Autopilot") {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Autopilot: ${selectedSpecName}`,
      cancellable: true,
    },
    async (progress, cancelToken) => {
      for (let i = 0; i < pending.length; i++) {
        if (cancelToken.isCancellationRequested) {
          break;
        }

        const task = pending[i];
        const increment = Math.round(100 / pending.length);
        progress.report({
          increment,
          message: `[${i + 1}/${pending.length}] ${task.title}`,
        });

        await executeTask(selectedSpecName, task, cancelToken);

        if (cancelToken.isCancellationRequested) {
          break;
        }
      }

      progress.report({ increment: 100, message: "Done!" });
    },
  );
}

async function executeTask(
  specName: string,
  task: Task,
  cancelToken: vscode.CancellationToken,
): Promise<void> {
  const confirmEach = vscode.workspace
    .getConfiguration("copilot-specs")
    .get<boolean>("autopilotConfirmEachTask", true);

  // Build context from spec docs
  const context = await buildTaskContext(specName, task);

  // Select model
  const model = await selectBestChatModel();
  if (!model) {
    vscode.window.showWarningMessage(
      "No language model available for Autopilot.",
    );
    return;
  }

  // Ask the model for an implementation plan
  const prompt = buildTaskPrompt(specName, task, context);
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];

  let response = "";
  try {
    const lmResponse = await model.sendRequest(messages, {}, cancelToken);
    for await (const chunk of lmResponse.text) {
      if (cancelToken.isCancellationRequested) {
        break;
      }
      response += chunk;
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Autopilot error on task "${task.title}": ${err}`,
    );
    return;
  }

  if (cancelToken.isCancellationRequested) {
    return;
  }

  if (confirmEach) {
    // Show the proposed implementation and ask for confirmation
    const panel = vscode.window.createOutputChannel(`Autopilot: ${task.title}`);
    panel.appendLine(`Task: ${task.id} — ${task.title}\n`);
    panel.appendLine(response);
    panel.show(true);

    const action = await vscode.window.showInformationMessage(
      `Autopilot: Apply changes for task "${task.title}"?`,
      "Apply & Complete",
      "Mark Complete Only",
      "Skip",
    );

    if (action === "Skip") {
      return;
    }
    if (action === "Apply & Complete") {
      await applyResponseAsEdit(response, task.title);
    }
  } else {
    await applyResponseAsEdit(response, task.title);
  }

  // Mark task and all subtasks as complete
  await markTaskAndSubtasksCompleted(specName, task.id, true);
}

async function buildTaskContext(
  specName: string,
  _task: Task,
): Promise<string> {
  const parts: string[] = [];

  const rUri = requirementsUri(specName);
  const dUri = designUri(specName);
  const tUri = tasksUri(specName);

  if (rUri && (await fileExists(rUri))) {
    parts.push(
      `## Requirements\n${stripFrontmatter(await readTextFile(rUri))}`,
    );
  }
  if (dUri && (await fileExists(dUri))) {
    parts.push(`## Design\n${stripFrontmatter(await readTextFile(dUri))}`);
  }
  if (tUri && (await fileExists(tUri))) {
    parts.push(`## All Tasks\n${await readTextFile(tUri)}`);
  }

  const steering = await readSteeringForContext();
  if (steering) {
    parts.push(`## Project Instructions\n${steering}`);
  }

  return parts.join("\n\n---\n\n");
}

function buildTaskPrompt(
  specName: string,
  task: Task,
  context: string,
): string {
  const subTaskList =
    task.subTasks.length > 0
      ? `\nSub-tasks:\n${task.subTasks.map((s) => `- [${s.completed ? "x" : " "}] ${s.title}`).join("\n")}`
      : "";

  return `You are an expert software engineer implementing a specific task as part of a larger feature spec.

**Spec:** ${specName}
**Task:** ${task.id} — ${task.title}${subTaskList}

**Context:**
${context}

---

Implement this task. For each file that needs to be created or modified:

1. Start with a line: \`FILE: path/to/file.ts\`
2. Then provide the complete file content in a code block
3. Explain any key decisions briefly after the code block

Be concrete and complete. Do not use placeholder comments like "// existing code here".
Only implement what is needed for this specific task.`;
}

export async function applyResponseAsEdit(
  response: string,
  taskTitle: string,
): Promise<void> {
  // Extract file blocks from response: FILE: path\n```lang\ncontent\n```
  const fileBlockRegex = /FILE:\s*(.+?)\n```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const edits: Array<{ filePath: string; content: string }> = [];

  while ((match = fileBlockRegex.exec(response)) !== null) {
    edits.push({ filePath: match[1].trim(), content: match[2] });
  }

  if (edits.length === 0) {
    // No structured file edits — just show in output
    vscode.window.showInformationMessage(
      `Task "${taskTitle}": No file edits detected. Check the Autopilot output channel.`,
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  for (const { filePath, content } of edits) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot, filePath);
    const uri = vscode.Uri.file(absPath);

    // Ensure parent directories exist
    const parentUri = vscode.Uri.file(path.dirname(absPath));
    await vscode.workspace.fs.createDirectory(parentUri);

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }
}
