import * as vscode from "vscode";
import * as path from "path";
import { listSpecs } from "./specManager.js";
import { loadTasks, calculateProgress } from "./taskManager.js";
import {
  readTextFile,
  fileExists,
  linksUri,
  ensureDir,
  resolveWorkspacePath,
} from "./utils/fileSystem.js";
import { SpecLinks, Task } from "./models/index.js";

const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".cs",
  ".java",
  ".kt",
  ".rs",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".h",
  ".hpp",
  ".swift",
  ".php",
  ".rb",
  ".scala",
  ".dart",
  ".lua",
]);

/** Matches a file path against a glob pattern */
function matchGlob(pattern: string, filePath: string): boolean {
  // Use vscode's built-in minimatch via RelativePattern
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(filePath),
  );
  if (!workspaceFolder) {
    return false;
  }
  const relPath = path
    .relative(workspaceFolder.uri.fsPath, filePath)
    .replace(/\\/g, "/");
  // Simple manual glob matching (avoid heavy deps)
  return minimatch(relPath, pattern);
}

/** Minimal glob match: supports ** and * wildcards */
export function matchGlobPattern(str: string, glob: string): boolean {
  return minimatch(str, glob);
}

function minimatch(str: string, glob: string): boolean {
  const regStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars except * and ?
    .replace(/\*\*/g, "§§§") // temp placeholder for **
    .replace(/\*/g, "[^/]*") // * matches anything but /
    .replace(/§§§/g, ".*") // ** matches anything
    .replace(/\?/g, "[^/]"); // ? matches single non-slash char
  return new RegExp(`^${regStr}$`).test(str);
}

async function loadLinks(specName: string): Promise<SpecLinks> {
  const uri = linksUri(specName);
  if (!uri) {
    return {};
  }
  try {
    if (await fileExists(uri)) {
      const content = await readTextFile(uri);
      const parsed = JSON.parse(content) as SpecLinks;
      return sanitizeLinks(parsed).links;
    }
  } catch {
    // ignore
  }
  return {};
}

async function saveLinks(specName: string, links: SpecLinks): Promise<void> {
  const uri = linksUri(specName);
  if (!uri) {
    return;
  }
  const sanitized = sanitizeLinks(links).links;
  // Ensure cache directory exists
  const cacheDir = vscode.Uri.joinPath(uri, "..");
  await ensureDir(cacheDir);
  const { writeTextFile } = await import("./utils/fileSystem.js");
  await writeTextFile(uri, JSON.stringify(sanitized, null, 2));
}

export class SpecCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  /** Tracks tasks currently being started: "specName::taskId" */
  private _inProgressTasks = new Set<string>();

  setTaskInProgress(
    specName: string,
    taskId: string,
    inProgress: boolean,
  ): void {
    const key = `${specName}::${taskId}`;
    if (inProgress) {
      this._inProgressTasks.add(key);
    } else {
      this._inProgressTasks.delete(key);
    }
    this._onDidChangeCodeLenses.fire();
  }

  isTaskInProgress(specName: string, taskId: string): boolean {
    return this._inProgressTasks.has(`${specName}::${taskId}`);
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const filePath = document.uri.fsPath;
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();

    const specNameFromTaskDoc = getSpecNameFromTasksDocumentPath(filePath);
    if (specNameFromTaskDoc) {
      return this.provideTaskDocumentCodeLenses(document, specNameFromTaskDoc);
    }

    const specNameFromReqDoc =
      getSpecNameFromRequirementsDocumentPath(filePath);
    if (specNameFromReqDoc) {
      return this.provideRequirementsDocumentCodeLenses(
        document,
        specNameFromReqDoc,
      );
    }

    const specNameFromDesignDoc =
      getSpecNameFromDesignDocumentPath(filePath);
    if (specNameFromDesignDoc) {
      return this.provideTaskDocumentCodeLenses(
        document,
        specNameFromDesignDoc,
      );
    }

    if (
      normalizedPath.includes("/.git/") ||
      normalizedPath.includes("/node_modules/")
    ) {
      return [];
    }

    const specs = await listSpecs();
    const matched: Array<{
      name: string;
      tasksPath: string;
      completed: number;
      total: number;
      pct: number;
      linkedTasks: Array<{ id: string; title: string; completed: boolean }>;
    }> = [];

    for (const spec of specs) {
      let isMatched = false;

      // Check if file matches the spec's applyTo glob
      if (spec.fileGlob && spec.fileGlob !== "**/*") {
        isMatched = matchGlob(spec.fileGlob, filePath);
      } else if (spec.fileGlob === "**/*") {
        isMatched = true;
      }

      // Check manual links
      if (!isMatched) {
        const links = await loadLinks(spec.name);
        const allLinkedFiles = Object.values(links).flat();
        isMatched = allLinkedFiles.some(
          (f) => path.normalize(f) === path.normalize(filePath),
        );
      }

      if (!isMatched) {
        continue;
      }

      const { tasks } = await loadTasks(spec.name);
      const progress = calculateProgress(tasks);
      const pct =
        progress.total > 0
          ? Math.round((progress.completed / progress.total) * 100)
          : 0;

      const links = await loadLinks(spec.name);
      const linkedTaskIds = new Set(
        Object.entries(links)
          .filter(([, paths]) =>
            paths.some((p) => path.normalize(p) === path.normalize(filePath)),
          )
          .map(([taskId]) => taskId),
      );

      const linkedTasks = tasks
        .filter((t) => linkedTaskIds.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, completed: t.completed }));

      matched.push({
        name: spec.name,
        tasksPath: spec.tasksPath,
        completed: progress.completed,
        total: progress.total,
        pct,
        linkedTasks,
      });
    }

    if (matched.length === 0) {
      return [];
    }

    matched.sort((a, b) => {
      if (a.linkedTasks.length !== b.linkedTasks.length) {
        return b.linkedTasks.length - a.linkedTasks.length;
      }
      if (a.pct !== b.pct) {
        return b.pct - a.pct;
      }
      return a.name.localeCompare(b.name);
    });

    const anchorRanges = await collectLensAnchorRanges(document);
    const primary = matched[0];
    const hasLinkedTasks = primary.linkedTasks.length > 0;

    const lenses: vscode.CodeLens[] = anchorRanges.map((range) => {
      if (hasLinkedTasks) {
        const firstTask = primary.linkedTasks[0];
        return new vscode.CodeLens(range, {
          title: `${firstTask.completed ? "[x]" : "[ ]"} Task ${firstTask.id}: ${firstTask.title}`,
          command: "copilot-specs.openTaskInTasksDocument",
          arguments: [primary.name, firstTask.id],
          tooltip: `Open task ${firstTask.id} in tasks document for "${primary.name}"`,
        });
      }

      return new vscode.CodeLens(range, {
        title: `Spec: ${primary.name} (${primary.completed}/${primary.total}, ${primary.pct}%)`,
        command: "copilot-specs.showRequirementTaskMap",
        arguments: [primary.name],
        tooltip: `Show requirement/task mapping for "${primary.name}"`,
      });
    });

    if (hasLinkedTasks && primary.linkedTasks.length > 1) {
      lenses.push(
        new vscode.CodeLens(anchorRanges[0], {
          title: `+${primary.linkedTasks.length - 1} more linked task(s)`,
          command: "copilot-specs.openTaskImplementations",
          arguments: [primary.name, primary.linkedTasks[0].id],
          tooltip: `Open tasks document for "${primary.name}"`,
        }),
      );
    }

    if (!hasLinkedTasks && matched.length > 1) {
      lenses.push(
        new vscode.CodeLens(anchorRanges[0], {
          title: `+${matched.length - 1} more matching spec(s)`,
          command: "copilot-specs.showRequirementTaskMap",
          tooltip: "Select a spec to view requirement/task mapping",
        }),
      );
    }

    return lenses;
  }

  private async provideTaskDocumentCodeLenses(
    document: vscode.TextDocument,
    specName: string,
  ): Promise<vscode.CodeLens[]> {
    let { tasks } = await loadTasks(specName);
    if (tasks.length === 0) {
      const { parseTasks } = await import("./taskManager.js");
      tasks = parseTasks(document.getText(), specName).tasks;
    }
    if (tasks.length === 0) {
      return [];
    }

    const links = await loadLinks(specName);
    const { requirementsUri, tasksUri } = await import("./utils/fileSystem.js");
    const reqUri = requirementsUri(specName);
    const tasksUriVal = tasksUri(specName);
    const requirementBlocks = reqUri && (await fileExists(reqUri))
      ? buildRequirementBlocks((await readTextFile(reqUri)).split("\n"))
      : new Map<string, RequirementBlock>();
    const taskBlocks = tasksUriVal && (await fileExists(tasksUriVal))
      ? buildTaskBlocks(await readTextFile(tasksUriVal), tasks)
      : buildTaskBlocks(document.getText(), tasks);
    const lenses: vscode.CodeLens[] = [];
    const topRange = new vscode.Range(0, 0, 0, 0);

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: `Spec: ${specName}`,
        command: "copilot-specs.openSpec",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "1 Requirements",
        command: "copilot-specs.openSpecRequirements",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "2 Design",
        command: "copilot-specs.openSpecDesign",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "3 Task list",
        command: "copilot-specs.openSpecTasks",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(sync) Sync Files",
        command: "copilot-specs.syncTasks",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(play) Run all tasks",
        command: "copilot-specs.runAllTasks",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(check-all) Run required tasks",
        command: "copilot-specs.runRequiredTasks",
        arguments: [specName],
      }),
    );

    for (const task of tasks) {
      const linkedFiles = links[task.id] ?? [];
      const linkedCount = linkedFiles.length;
      const line = Math.max(
        0,
        Math.min(task.lineIndex, document.lineCount - 1),
      );
      const range = new vscode.Range(line, 0, line, 0);

      let requirementPart =
        task.requirementIds && task.requirementIds.length > 0
          ? `Addresses: ${task.requirementIds.join(", ")}`
          : "No requirements linked";

      let filePart =
        linkedCount === 1
          ? path.basename(linkedFiles[0])
          : linkedCount > 1
            ? `${linkedCount} implementation file(s)`
            : "No implementation files";

      if (!task.requirementIds || task.requirementIds.length === 0) {
        const fromText = extractRequirementIdsFromText(
          taskBlocks.get(task.id) ?? "",
        );
        if (fromText.length > 0) {
          requirementPart = `Addresses: ${fromText.join(", ")} (from text)`;
        } else if (requirementBlocks.size > 0) {
          const inferred = inferRequirementsForTask(task, requirementBlocks);
          if (inferred.length > 0) {
            requirementPart = `Addresses: ${inferred.join(", ")} (inferred)`;
          }
        }
      }

      lenses.push(
        new vscode.CodeLens(range, {
          title: requirementPart,
          command: "copilot-specs.openTaskRequirements",
          arguments: [specName, task.id],
          tooltip: `Open requirements linked to task ${task.id}`,
        }),
      );

      if (linkedCount > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: filePart,
            command: "copilot-specs.openTaskImplementations",
            arguments: [specName, task.id],
            tooltip: `Open linked implementation files for task ${task.id}`,
          }),
        );
      }

      const inProgress = this.isTaskInProgress(specName, task.id);

      if (inProgress) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(sync~spin) In progress",
            command: "",
            tooltip: `Task ${task.id} is being worked on`,
          }),
        );
      } else if (task.completed) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(pass-filled) Task completed",
            command: "",
            tooltip: `Task ${task.id} is completed`,
          }),
          new vscode.CodeLens(range, {
            title: "$(comment-discussion) View session",
            command: "copilot-specs.startTask",
            arguments: [specName, task.id],
            tooltip: `View task ${task.id} execution context`,
          }),
        );
      } else if (!task.completed) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(zap) Start task",
            command: "copilot-specs.startTask",
            arguments: [specName, task.id],
            tooltip: `Start task ${task.id} with Copilot`,
          }),
          new vscode.CodeLens(range, {
            title: task.autoVerified
              ? "$(list-ordered) Make task optional"
              : "$(list-ordered) Make task required",
            command: "copilot-specs.toggleTaskRequired",
            arguments: [specName, task.id],
            tooltip: task.autoVerified
              ? `Remove required flag (*) from task ${task.id}`
              : `Make task ${task.id} required (*)`,
          }),
        );
      }
    }

    return lenses;
  }

  private async provideRequirementsDocumentCodeLenses(
    document: vscode.TextDocument,
    specName: string,
  ): Promise<vscode.CodeLens[]> {
    const { tasks } = await loadTasks(specName);
    const content = document.getText();
    const lines = content.split("\n");
    const requirementBlocks = buildRequirementBlocks(lines);

    const { tasksUri } = await import("./utils/fileSystem.js");
    const tasksFileUri = tasksUri(specName);
    const taskBlocks = tasksFileUri
      ? buildTaskBlocks(await readTextFile(tasksFileUri), tasks)
      : new Map<string, string>();
    const lenses: vscode.CodeLens[] = [];
    const topRange = new vscode.Range(0, 0, 0, 0);

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: `Spec: ${specName}`,
        command: "copilot-specs.openSpec",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "1 Requirements",
        command: "copilot-specs.openSpecRequirements",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "2 Design",
        command: "copilot-specs.openSpecDesign",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "3 Task list",
        command: "copilot-specs.openSpecTasks",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(sparkle) Update requirements",
        command: "copilot-specs.generateWithCopilot",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(search) Analyze Requirements",
        command: "copilot-specs.analyzeRequirements",
        arguments: [specName],
      }),
      new vscode.CodeLens(topRange, {
        title: "$(pass) Check Correctness",
        command: "copilot-specs.checkCorrectness",
        arguments: [specName],
      }),
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const requirementIds = extractRequirementIdsFromLine(line);
      for (const req of requirementIds) {
        const reqId = normalizeRequirementId(req.id);
        const col = req.column;
        const explicitTasks = tasks.filter((task) =>
          taskAddressesRequirement(task, reqId),
        );

        const tasksByIdMention =
          explicitTasks.length === 0
            ? tasks.filter((task) =>
                taskMentionsRequirement(task, reqId, taskBlocks),
              )
            : [];

        const block = requirementBlocks.get(reqId);
        const inferredTasks =
          explicitTasks.length === 0 && tasksByIdMention.length === 0 && block
            ? inferTasksForRequirement(block, tasks)
            : [];

        const addressingTasks =
          explicitTasks.length > 0
            ? explicitTasks
            : tasksByIdMention.length > 0
              ? tasksByIdMention
              : inferredTasks;

        const range = new vscode.Range(i, col, i, col + reqId.length);
        const taskList = addressingTasks
          .map((t) => `${t.id}${t.completed ? " ✓" : ""}`)
          .join(", ");

        if (addressingTasks.length > 0) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `${addressingTasks.length} task(s): ${taskList}`,
              command: "copilot-specs.openRequirementTasks",
              arguments: [specName, reqId],
              tooltip: `Show tasks that address requirement ${reqId}`,
            }),
          );
        }
      }
    }

    return lenses;
  }
}

export async function openTaskImplementations(
  specName: string,
  taskId: string,
): Promise<void> {
  const links = await loadLinks(specName);
  const files = (links[taskId] ?? []).filter((f) => isSourceCodeFilePath(f));

  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `Task ${taskId} has no linked implementation files yet.`,
    );
    return;
  }

  if (files.length === 1) {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(files[0]),
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    files.map((filePath) => {
      const uri = vscode.Uri.file(filePath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const rel = workspaceFolder
        ? path
            .relative(workspaceFolder.uri.fsPath, filePath)
            .replace(/\\/g, "/")
        : filePath;
      return {
        label: path.basename(filePath),
        description: rel,
        detail: filePath,
        filePath,
      };
    }),
    {
      placeHolder: `Select implementation file for task ${taskId}`,
    },
  );

  if (!pick) {
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.open",
    vscode.Uri.file(pick.filePath),
  );
}

export async function openRequirementTasks(
  specName: string,
  requirementId: string,
): Promise<void> {
  const normalizedRequirementId = normalizeRequirementId(requirementId);
  const { tasks } = await loadTasks(specName);
  let addressingTasks = tasks.filter((task) =>
    taskAddressesRequirement(task, normalizedRequirementId),
  );

  if (addressingTasks.length === 0) {
    const { requirementsUri, tasksUri } = await import("./utils/fileSystem.js");
    const reqUri = requirementsUri(specName);
    const tasksUriVal = tasksUri(specName);
    if (reqUri && tasksUriVal) {
      const reqContent = await readTextFile(reqUri);
      const blocks = buildRequirementBlocks(reqContent.split("\n"));
      const taskBlocks = buildTaskBlocks(
        await readTextFile(tasksUriVal),
        tasks,
      );
      addressingTasks = tasks.filter((task) =>
        taskMentionsRequirement(task, normalizedRequirementId, taskBlocks),
      );

      if (addressingTasks.length === 0) {
        const block = blocks.get(normalizedRequirementId);
        if (block) {
          addressingTasks = inferTasksForRequirement(block, tasks);
        }
      }
    }
  }

  if (addressingTasks.length === 0) {
    vscode.window.showInformationMessage(
      `No tasks address requirement ${normalizedRequirementId}.`,
    );
    return;
  }

  // Navigate to tasks document and highlight the first task
  const { tasksUri } = await import("./utils/fileSystem.js");
  const tasksFileUri = tasksUri(specName);
  if (!tasksFileUri) {
    return;
  }

  const editor = await vscode.window.showTextDocument(tasksFileUri);
  if (addressingTasks.length > 1) {
    const pick = await vscode.window.showQuickPick(
      addressingTasks.map((task) => ({
        label: `${task.completed ? "$(check) " : ""}${task.id}`,
        description: task.title,
        task,
      })),
      {
        placeHolder: `Select a task for requirement ${requirementId}`,
      },
    );
    if (!pick) {
      return;
    }

    const line = Math.max(
      0,
      Math.min(pick.task.lineIndex, editor.document.lineCount - 1),
    );
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(
      new vscode.Range(line, 0, line, 0),
      vscode.TextEditorRevealType.InCenter,
    );
    return;
  }

  const task = addressingTasks[0];
  const line = Math.max(
    0,
    Math.min(task.lineIndex, editor.document.lineCount - 1),
  );
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(
    new vscode.Range(line, 0, line, 0),
    vscode.TextEditorRevealType.InCenter,
  );
}

export async function openTaskRequirements(
  specName: string,
  taskId: string,
): Promise<void> {
  const { tasks } = await loadTasks(specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return;
  }

  let requirementIds = task.requirementIds ?? [];

  const { requirementsUri } = await import("./utils/fileSystem.js");
  const reqUri = requirementsUri(specName);
  if (!reqUri) {
    return;
  }

  if (requirementIds.length === 0) {
    const { tasksUri } = await import("./utils/fileSystem.js");
    const tasksUriVal = tasksUri(specName);
    if (tasksUriVal) {
      const reqContent = await readTextFile(reqUri);
      const blocks = buildRequirementBlocks(reqContent.split("\n"));
      const taskBlocks = buildTaskBlocks(
        await readTextFile(tasksUriVal),
        tasks,
      );
      const fromText = extractRequirementIdsFromText(
        taskBlocks.get(task.id) ?? "",
      );
      requirementIds =
        fromText.length > 0 ? fromText : inferRequirementsForTask(task, blocks);
    }
  }

  if (requirementIds.length === 0) {
    vscode.window.showInformationMessage(
      `Task ${taskId} has no linked requirements.`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(reqUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  const selectedRequirementId =
    requirementIds.length === 1
      ? normalizeRequirementId(requirementIds[0])
      : (
          await vscode.window.showQuickPick(
            requirementIds.map((id) => ({ label: normalizeRequirementId(id) })),
            { placeHolder: `Select requirement for task ${taskId}` },
          )
        )?.label;

  if (!selectedRequirementId) {
    return;
  }

  const requirementPattern = new RegExp(
    `(^|\\s|\\*\\*|#+\\s)${escapeRegExp(selectedRequirementId)}(?=\\b|\\*\\*|\\s|:)`,
    "i",
  );

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!requirementPattern.test(text)) {
      continue;
    }

    const col = Math.max(
      0,
      text.toLowerCase().indexOf(selectedRequirementId.toLowerCase()),
    );
    editor.selection = new vscode.Selection(line, col, line, col);
    editor.revealRange(
      new vscode.Range(line, col, line, col),
      vscode.TextEditorRevealType.InCenter,
    );
    return;
  }

  vscode.window.showInformationMessage(
    `Requirement ${selectedRequirementId} not found in requirements document.`,
  );
}

export async function openTaskReferencedFiles(
  specName: string,
  taskId: string,
): Promise<void> {
  const { tasks } = await loadTasks(specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return;
  }

  const { tasksUri } = await import("./utils/fileSystem.js");
  const tasksUriVal = tasksUri(specName);
  if (!tasksUriVal) {
    return;
  }

  const taskBlocks = buildTaskBlocks(await readTextFile(tasksUriVal), tasks);
  const taskText = taskBlocks.get(task.id) ?? task.title;
  const referenced = await resolveReferencedFiles(taskText);

  if (referenced.length === 0) {
    vscode.window.showInformationMessage(
      `Task ${taskId} has no referenced files in its text.`,
    );
    return;
  }

  if (referenced.length === 1) {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(referenced[0]),
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    referenced.map((filePath) => {
      const uri = vscode.Uri.file(filePath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const rel = workspaceFolder
        ? path
            .relative(workspaceFolder.uri.fsPath, filePath)
            .replace(/\\/g, "/")
        : filePath;
      return {
        label: path.basename(filePath),
        description: rel,
        detail: filePath,
        filePath,
      };
    }),
    {
      placeHolder: `Select referenced file for task ${taskId}`,
    },
  );

  if (!pick) {
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.open",
    vscode.Uri.file(pick.filePath),
  );
}

export async function showRequirementTaskMap(specName: string): Promise<void> {
  const output = vscode.window.createOutputChannel(
    "Copilot Specs: Requirement Map",
  );

  const { tasks } = await loadTasks(specName);
  const { requirementsUri } = await import("./utils/fileSystem.js");
  const reqUri = requirementsUri(specName);
  if (!reqUri) {
    output.appendLine(`Spec "${specName}" has no requirements file.`);
    output.show(true);
    return;
  }

  const content = await readTextFile(reqUri);
  const lines = content.split("\n");
  const blocks = buildRequirementBlocks(lines);
  const requirementIds = new Set<string>([...blocks.keys()]);

  const { tasksUri } = await import("./utils/fileSystem.js");
  const tasksFileUri = tasksUri(specName);
  const taskBlocks = tasksFileUri
    ? buildTaskBlocks(await readTextFile(tasksFileUri), tasks)
    : new Map<string, string>();

  output.appendLine(`Spec: ${specName}`);
  output.appendLine(`Requirements detected: ${[...requirementIds].join(", ")}`);
  output.appendLine("\nRequirement -> Tasks");

  for (const reqId of requirementIds) {
    const addressing = tasks
      .filter((task) => taskAddressesRequirement(task, reqId))
      .map((task) => task.id);
    const fromText =
      addressing.length === 0
        ? tasks
            .filter((task) => taskMentionsRequirement(task, reqId, taskBlocks))
            .map((task) => task.id)
        : [];
    const inferred =
      addressing.length === 0 && fromText.length === 0
        ? inferTasksForRequirement(blocks.get(reqId), tasks).map(
            (task) => task.id,
          )
        : [];
    output.appendLine(
      `${reqId}: ${addressing.length > 0 ? addressing.join(", ") : fromText.length > 0 ? `${fromText.join(", ")} (from text)` : inferred.length > 0 ? `${inferred.join(", ")} (inferred)` : "NO_TASKS"}`,
    );
  }

  output.appendLine("\nTask -> Requirements");
  for (const task of tasks) {
    const reqs = (task.requirementIds ?? []).map((id) =>
      normalizeRequirementId(id),
    );
    const fromText =
      reqs.length === 0
        ? extractRequirementIdsFromText(taskBlocks.get(task.id) ?? "")
        : [];
    const inferredReqs =
      reqs.length === 0 && fromText.length === 0
        ? inferRequirementsForTask(task, blocks)
        : [];
    output.appendLine(
      `${task.id}: ${reqs.length > 0 ? reqs.join(", ") : fromText.length > 0 ? `${fromText.join(", ")} (from text)` : inferredReqs.length > 0 ? `${inferredReqs.join(", ")} (inferred)` : "NO_REQS"}`,
    );
  }

  output.show(true);
}

export async function linkCurrentFileToTask(specProvider: {
  refresh(): void;
}): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active file to link.");
    return;
  }
  const filePath = editor.document.uri.fsPath;
  if (!isSourceCodeFilePath(filePath)) {
    vscode.window.showWarningMessage(
      "Only source code files can be linked to tasks.",
    );
    return;
  }

  const specs = await listSpecs();
  if (specs.length === 0) {
    return;
  }

  const specPick = await vscode.window.showQuickPick(
    specs.map((s) => ({ label: s.name, description: s.fileGlob })),
    { placeHolder: "Select a spec to link this file to" },
  );
  if (!specPick) {
    return;
  }

  const { tasks } = await loadTasks(specPick.label);
  if (tasks.length === 0) {
    vscode.window.showInformationMessage(
      `Spec "${specPick.label}" has no tasks.`,
    );
    return;
  }

  const taskPick = await vscode.window.showQuickPick(
    tasks.map((t) => ({ label: t.id, description: t.title, task: t })),
    { placeHolder: "Select a task to link this file to" },
  );
  if (!taskPick) {
    return;
  }

  const links = await loadLinks(specPick.label);
  const existing = links[taskPick.label] ?? [];
  if (!existing.includes(filePath)) {
    links[taskPick.label] = [...existing, filePath];
    await saveLinks(specPick.label, links);
  }

  specProvider.refresh();
  vscode.window.showInformationMessage(
    `Linked "${path.basename(filePath)}" to task ${taskPick.label} in spec "${specPick.label}".`,
  );
}

export async function linkExistingTaskToImplementation(
  specProvider: {
    refresh(): void;
  },
  options?: { silent?: boolean },
): Promise<void> {
  const specs = await listSpecs();
  if (specs.length === 0) {
    return;
  }

  const excludeGlob =
    "{**/.git/**,**/node_modules/**,**/.github/**,**/dist/**,**/build/**,**/.next/**,**/.vscode/**}";

  let totalTasks = 0;
  let updatedTasks = 0;
  let linkedFiles = 0;

  for (const spec of specs) {
    const { tasks } = await loadTasks(spec.name);
    if (tasks.length === 0) {
      continue;
    }

    totalTasks += tasks.length;

    const includeGlob =
      spec.fileGlob && spec.fileGlob.trim() ? spec.fileGlob : "**/*";

    let files = await vscode.workspace.findFiles(
      includeGlob,
      excludeGlob,
      2000,
    );
    if (files.length === 0 && includeGlob !== "**/*") {
      files = await vscode.workspace.findFiles("**/*", excludeGlob, 2000);
    }

    const fileMeta = files
      .filter((uri) => isSourceCodeFilePath(uri.fsPath))
      .map((uri) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const rel = workspaceFolder
          ? path
              .relative(workspaceFolder.uri.fsPath, uri.fsPath)
              .replace(/\\/g, "/")
          : uri.fsPath;
        return {
          fsPath: uri.fsPath,
          relLower: rel.toLowerCase(),
        };
      });

    const loadedLinks = await loadLinks(spec.name);
    const sanitized = sanitizeLinks(loadedLinks);
    const links = sanitized.links;
    let changed = sanitized.changed;

    for (const task of tasks) {
      const existing = new Set(
        (links[task.id] ?? [])
          .filter((f) => isSourceCodeFilePath(f))
          .map((f) => path.normalize(f)),
      );
      const auto = new Set<string>(existing);

      const idHits = await findFilesContainingTaskId(
        task.id,
        includeGlob,
        excludeGlob,
      );
      for (const hit of idHits) {
        auto.add(path.normalize(hit));
      }

      const keywords = extractKeywords(task.title);
      if (keywords.length >= 2) {
        for (const fm of fileMeta) {
          const matchedKeywords = keywords.filter((k) =>
            fm.relLower.includes(k),
          ).length;
          if (matchedKeywords >= 2) {
            auto.add(path.normalize(fm.fsPath));
          }
        }
      }

      const next = [...auto].sort();
      const prev = [...existing].sort();

      if (next.length > 0) {
        links[task.id] = next;
      }

      if (next.length !== prev.length || next.some((v, i) => v !== prev[i])) {
        changed = true;
        updatedTasks++;
      }

      linkedFiles += next.length;
    }

    if (changed) {
      await saveLinks(spec.name, links);
    }
  }

  specProvider.refresh();
  if (!options?.silent) {
    vscode.window.showInformationMessage(
      `Auto-linked ${updatedTasks}/${totalTasks} task(s), ${linkedFiles} file link(s) total.`,
    );
  }
}

async function findFilesContainingTaskId(
  taskId: string,
  includeGlob: string,
  excludeGlob: string,
): Promise<Set<string>> {
  const escaped = escapeRegExp(taskId);
  const pattern = new RegExp(`task:${escaped}|\\b${escaped}\\b`, "i");
  const hits = new Set<string>();

  const files = await vscode.workspace.findFiles(
    includeGlob,
    excludeGlob,
    2000,
  );
  for (const uri of files) {
    if (!isSourceCodeFilePath(uri.fsPath)) {
      continue;
    }
    try {
      const content = await readTextFile(uri);
      if (content.length > 600_000) {
        continue;
      }
      if (pattern.test(content) || pattern.test(uri.fsPath)) {
        hits.add(uri.fsPath);
      }
    } catch {
      // ignore unreadable / binary files
    }
  }

  return hits;
}

function extractKeywords(title: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "task",
    "implement",
    "implementation",
    "create",
    "add",
    "update",
    "basic",
    "core",
  ]);

  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopwords.has(token))
    .slice(0, 6);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRequirementId(value: string): string {
  return value
    .trim()
    .replace(/^[-*\s:]+|[-*\s:]+$/g, "")
    .toUpperCase();
}

function taskAddressesRequirement(
  task: { title: string; requirementIds?: string[] },
  normalizedRequirementId: string,
): boolean {
  if (
    task.requirementIds &&
    task.requirementIds.some(
      (rid) => normalizeRequirementId(rid) === normalizedRequirementId,
    )
  ) {
    return true;
  }

  const titleIds =
    task.title
      .match(/\b([A-Z]+-\d+(?:\.\d+)*|R\d+)\b/gi)
      ?.map((id) => normalizeRequirementId(id)) ?? [];

  return titleIds.includes(normalizedRequirementId);
}

type RequirementBlock = {
  id: string;
  text: string;
  line: number;
  title: string;
  keywords: string[];
};

function buildRequirementBlocks(
  lines: string[],
): Map<string, RequirementBlock> {
  const blocks: Array<{ id: string; line: number }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const ids = extractRequirementIdsFromLine(lines[i]);
    for (const id of ids) {
      const normalized = normalizeRequirementId(id.id);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      blocks.push({ id: normalized, line: i });
    }
  }

  const result = new Map<string, RequirementBlock>();
  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].line;
    const end =
      i + 1 < blocks.length ? blocks[i + 1].line - 1 : lines.length - 1;
    const text = lines
      .slice(start, end + 1)
      .join("\n")
      .trim();
    const titleLine = lines[start] ?? "";
    const title = extractRequirementTitle(titleLine, blocks[i].id);
    const keywords = extractLinkKeywords(title || text);
    result.set(blocks[i].id, {
      id: blocks[i].id,
      text,
      line: start,
      title,
      keywords,
    });
  }

  return result;
}

function buildTaskBlocks(
  content: string,
  tasks: Array<{ id: string; lineIndex: number; title: string }>,
): Map<string, string> {
  const lines = content.split("\n");
  const sorted = [...tasks].sort((a, b) => a.lineIndex - b.lineIndex);
  const map = new Map<string, string>();

  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].lineIndex;
    const end =
      i + 1 < sorted.length ? sorted[i + 1].lineIndex - 1 : lines.length - 1;
    map.set(
      sorted[i].id,
      lines
        .slice(start, end + 1)
        .join("\n")
        .trim(),
    );
  }

  return map;
}

function inferTasksForRequirement(
  block: RequirementBlock | undefined,
  tasks: Task[],
): Task[] {
  if (!block || block.keywords.length === 0) {
    return [];
  }

  const requirementKeywords = block.keywords;
  const scored = tasks
    .map((task) => {
      const taskKeywords = extractLinkKeywords(task.title);
      const overlap = requirementKeywords.filter((k) =>
        taskKeywords.includes(k),
      );
      const ratio =
        overlap.length /
        Math.max(requirementKeywords.length, taskKeywords.length || 1);
      return { task, score: overlap.length, ratio };
    })
    .filter((entry) =>
      requirementKeywords.length >= 3
        ? entry.score >= 2 && entry.ratio >= 0.4
        : entry.score >= 2,
    )
    .sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));

  return scored.map((entry) => entry.task);
}

function inferRequirementsForTask(
  task: { id: string; title: string },
  blocks: Map<string, RequirementBlock>,
): string[] {
  const taskKeywords = extractLinkKeywords(task.title);
  if (taskKeywords.length === 0) {
    return [];
  }

  const scored = [...blocks.values()]
    .map((block) => {
      const overlap = block.keywords.filter((k) => taskKeywords.includes(k));
      const ratio =
        overlap.length /
        Math.max(block.keywords.length, taskKeywords.length || 1);
      return { id: block.id, score: overlap.length, ratio };
    })
    .filter((entry) =>
      taskKeywords.length >= 3
        ? entry.score >= 2 && entry.ratio >= 0.4
        : entry.score >= 2,
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return scored.map((entry) => entry.id);
}

function extractRequirementIdsFromText(text: string): string[] {
  const matches = text.match(/\b((?:NFR|FR|REQ)-\d+(?:\.\d+)*|R\d+)\b/gi) ?? [];
  return [...new Set(matches.map((m) => normalizeRequirementId(m)))];
}

function taskMentionsRequirement(
  task: { id: string },
  normalizedRequirementId: string,
  taskBlocks: Map<string, string>,
): boolean {
  const text = taskBlocks.get(task.id) ?? "";
  const ids = extractRequirementIdsFromText(text);
  return ids.includes(normalizedRequirementId);
}

function extractRequirementTitle(line: string, id: string): string {
  const withoutHashes = line.replace(/^\s*#{1,6}\s+/, "");
  const pattern = new RegExp(`^${escapeRegExp(id)}\s*[:\-–]?\s*`, "i");
  return withoutHashes.replace(pattern, "").trim();
}

function extractLinkKeywords(text: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "system",
    "shall",
    "must",
    "should",
    "user",
    "users",
    "requirement",
    "requirements",
    "task",
    "tasks",
    "feature",
    "functional",
    "nonfunctional",
    "create",
    "implement",
    "support",
    "provide",
    "allow",
    "include",
    "using",
  ]);

  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 5 && !stopwords.has(token))
    .slice(0, 8);
}

function extractFileReferences(text: string): string[] {
  const refs = new Set<string>();

  const backtickPattern = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickPattern.exec(text)) !== null) {
    refs.add(match[1].trim());
  }

  const inlinePattern =
    /(?:^|\s)([./][\w./-]*\.[\w]+|[\w./-]+\.[\w]+)(?=\s|$)/g;
  while ((match = inlinePattern.exec(text)) !== null) {
    refs.add(match[1].trim());
  }

  return [...refs]
    .map((ref) => ref.replace(/[),.;:]+$/, ""))
    .filter((ref) => ref.length > 0 && !/^https?:/i.test(ref));
}

async function resolveReferencedFiles(text: string): Promise<string[]> {
  const refs = extractFileReferences(text);
  const resolved = new Set<string>();

  for (const ref of refs) {
    const cleaned = ref.replace(/^\.\//, "").replace(/^\.\\/, "");
    const uri = path.isAbsolute(cleaned)
      ? vscode.Uri.file(cleaned)
      : resolveWorkspacePath(cleaned);
    if (uri && (await fileExists(uri))) {
      resolved.add(uri.fsPath);
      continue;
    }

    // Fallback: search anywhere in workspace by path suffix/filename.
    const normalized = cleaned.replace(/\\/g, "/").replace(/^\//, "");
    const glob = normalized.includes("/")
      ? `**/${normalized}`
      : `**/${normalized}`;
    const found = await vscode.workspace.findFiles(
      glob,
      "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/.next/**}",
      20,
    );
    for (const match of found) {
      resolved.add(match.fsPath);
    }
  }

  return [...resolved];
}

function extractRequirementIdsFromLine(
  line: string,
): Array<{ id: string; column: number }> {
  const out: Array<{ id: string; column: number }> = [];

  const headingMatch = line.match(
    /^\s*#{1,6}\s+([A-Z]+(?:-\d+(?:\.\d+)*)?|R\d+)\b/,
  );
  if (headingMatch && typeof headingMatch.index === "number") {
    out.push({
      id: normalizeRequirementId(headingMatch[1]),
      column:
        headingMatch.index +
        line.slice(headingMatch.index).indexOf(headingMatch[1]),
    });
  }

  const boldBullet = /\*\*([A-Z]+(?:-\d+(?:\.\d+)*)?|R\d+)\*\*/g;
  let bulletMatch: RegExpExecArray | null;
  while ((bulletMatch = boldBullet.exec(line)) !== null) {
    out.push({
      id: normalizeRequirementId(bulletMatch[1]),
      column: bulletMatch.index + 2,
    });
  }

  const plainPrefix = /^\s*[-*]?\s*([A-Z]+(?:-\d+(?:\.\d+)*)?|R\d+)\s*:/;
  const plainMatch = line.match(plainPrefix);
  if (plainMatch && typeof plainMatch.index === "number") {
    const column = line.indexOf(plainMatch[1]);
    if (column >= 0) {
      out.push({ id: normalizeRequirementId(plainMatch[1]), column });
    }
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.id}:${item.column}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getSpecNameFromTasksDocumentPath(
  filePath: string,
): string | undefined {
  const fileName = path.basename(filePath).toLowerCase();
  const taskDocNames = [
    "tasks.instructions.md",
    "implementation-tasks.instructions.md",
    "tasks.md",
    "tasks-quick.template.md",
  ];
  if (taskDocNames.includes(fileName)) {
    return path.basename(path.dirname(filePath));
  }
  return undefined;
}

function getSpecNameFromRequirementsDocumentPath(
  filePath: string,
): string | undefined {
  const fileName = path.basename(filePath).toLowerCase();
  const reqDocNames = [
    "requirements.instructions.md",
    "requirements.md",
    "bugfix-analysis.md",
    "bugfix-analysis.template.md",
  ];
  if (reqDocNames.includes(fileName)) {
    return path.basename(path.dirname(filePath));
  }
  return undefined;
}

function getSpecNameFromDesignDocumentPath(
  filePath: string,
): string | undefined {
  const fileName = path.basename(filePath).toLowerCase();
  const designDocNames = [
    "design.instructions.md",
    "design.md",
    "fix-plan.md",
    "fix-plan.template.md",
  ];
  if (designDocNames.includes(fileName)) {
    return path.basename(path.dirname(filePath));
  }
  return undefined;
}

function sanitizeLinks(links: SpecLinks): {
  links: SpecLinks;
  changed: boolean;
} {
  const next: SpecLinks = {};
  let changed = false;

  for (const [taskId, paths] of Object.entries(links)) {
    const original = Array.isArray(paths) ? paths : [];
    const dedup = new Set<string>();
    for (const filePath of original) {
      if (typeof filePath !== "string") {
        changed = true;
        continue;
      }
      if (!isSourceCodeFilePath(filePath)) {
        changed = true;
        continue;
      }
      dedup.add(path.normalize(filePath));
    }

    const filtered = [...dedup];
    if (filtered.length > 0) {
      next[taskId] = filtered;
    }

    if (filtered.length !== original.length) {
      changed = true;
    }
  }

  return { links: next, changed };
}

function isSourceCodeFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }

  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  if (
    normalized.includes("/.git/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/build/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/.vscode/") ||
    normalized.includes("/.github/")
  ) {
    return false;
  }

  const ext = path.extname(normalized);
  return SOURCE_FILE_EXTENSIONS.has(ext);
}

async function collectLensAnchorRanges(
  document: vscode.TextDocument,
): Promise<vscode.Range[]> {
  const symbolRanges = await getClassAndMethodRanges(document);
  if (symbolRanges.length > 0) {
    return symbolRanges;
  }
  const parsedRanges = getClassAndMethodRangesFromText(document);
  if (parsedRanges.length > 0) {
    return parsedRanges;
  }
  return [new vscode.Range(0, 0, 0, 0)];
}

async function getClassAndMethodRanges(
  document: vscode.TextDocument,
): Promise<vscode.Range[]> {
  let symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[] | vscode.SymbolInformation[]
    >("vscode.executeDocumentSymbolProvider", document.uri);
  } catch {
    return [];
  }

  if (!symbols || symbols.length === 0) {
    return [];
  }

  const kinds = new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Constructor,
  ]);

  const lineSet = new Set<number>();
  const ranges: vscode.Range[] = [];

  if (symbols[0] instanceof vscode.SymbolInformation) {
    for (const symbol of symbols as vscode.SymbolInformation[]) {
      if (!kinds.has(symbol.kind)) {
        continue;
      }
      const line = symbol.location.range.start.line;
      if (lineSet.has(line)) {
        continue;
      }
      lineSet.add(line);
      ranges.push(new vscode.Range(line, 0, line, 0));
    }
  } else {
    const walk = (items: vscode.DocumentSymbol[]): void => {
      for (const symbol of items) {
        if (kinds.has(symbol.kind)) {
          const line = symbol.selectionRange.start.line;
          if (!lineSet.has(line)) {
            lineSet.add(line);
            ranges.push(new vscode.Range(line, 0, line, 0));
          }
        }
        if (symbol.children.length > 0) {
          walk(symbol.children);
        }
      }
    };
    walk(symbols as vscode.DocumentSymbol[]);
  }

  ranges.sort((a, b) => a.start.line - b.start.line);
  return ranges;
}

function getClassAndMethodRangesFromText(
  document: vscode.TextDocument,
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const seenLines = new Set<number>();

  const classLike =
    /\b(class|interface|struct|enum|record)\s+[A-Za-z_][A-Za-z0-9_]*/;
  const methodLike =
    /\b[A-Za-z_][A-Za-z0-9_<>,\[\]?\.]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\)\s*(?:\{|=>|where\b)?/;

  for (let line = 0; line < document.lineCount; line++) {
    const raw = document.lineAt(line).text;
    const text = raw.trim();
    if (!text) {
      continue;
    }
    if (
      text.startsWith("//") ||
      text.startsWith("/*") ||
      text.startsWith("*") ||
      text.startsWith("#") ||
      text.startsWith("[")
    ) {
      continue;
    }

    const isClass = classLike.test(text);
    const isMethod =
      methodLike.test(text) &&
      !/\b(if|for|foreach|while|switch|catch|using|return|new)\b/.test(text);

    if (!isClass && !isMethod) {
      continue;
    }

    if (!seenLines.has(line)) {
      seenLines.add(line);
      ranges.push(new vscode.Range(line, 0, line, 0));
    }
  }

  return ranges;
}
