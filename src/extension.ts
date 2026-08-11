import * as vscode from "vscode";
import * as path from "node:path";

import {
  initTemplates,
  promptCreateSpec,
  promptCreateBugfixSpec,
  promptCreateQuickSpec,
  promptCreateSpecWizard,
  listSpecs,
  deleteSpec,
  renameSpec,
  loadSpec,
} from "./specManager.js";
import {
  loadTasks,
  setTaskCompleted,
  markTaskAndSubtasksCompleted,
  calculateProgress,
  validateTaskMarkdown,
} from "./taskManager.js";
import {
  SpecProvider,
  SteeringProvider,
  HooksProvider,
  HookItem,
  MCPServersProvider,
  MCPServerItem,
  TaskItem,
} from "./specProvider.js";
import { SpecStatusBar } from "./statusBar.js";
import {
  SpecCodeLensProvider,
  linkCurrentFileToTask,
  linkExistingTaskToImplementation,
  openTaskImplementations,
  openRequirementTasks,
  openTaskRequirements,
  showRequirementTaskMap,
  openTaskReferencedFiles,
} from "./codeLensProvider.js";
import {
  readAllSteering,
  promptNewSteering,
  openSteeringFile,
} from "./steeringManager.js";
import {
  listHooks,
  createHook,
  runHook,
  setHookEnabled,
  registerHookWatchers,
  initHooks,
} from "./hooksManager.js";
import { registerChatParticipant } from "./copilot/chatParticipant.js";
import {
  buildStartTaskPrompt,
  buildRunAllTasksVerificationPrompt,
} from "./copilot/taskStarter.js";
import { runAutopilot } from "./autopilot.js";
import { promptSelectModel } from "./copilot/specGenerator.js";
import {
  listMcpConfigTargets,
  listMcpServers,
  setMcpServerEnabled,
  getPreferredWorkspaceMcpConfigPath,
} from "./mcpManager.js";
import {
  SPECS_DIR,
  INSTRUCTIONS_DIR,
  HOOKS_DIR,
  PROMPTS_DIR,
  copilotInstructionsUri,
  fileExists,
  listSkillFiles,
  listInstructionRulesFiles,
  listPromptFiles,
  listWorkflowFiles,
  WORKFLOWS_DIR,
  ensureGitignoreEntry,
  resolveWorkspacePath,
} from "./utils/fileSystem.js";
import { Task } from "./models/index.js";
import { HookEventName } from "./models/index.js";
import { GitTodoService } from "./todos/gitTodoService.js";
import { TodoManager } from "./todos/todoManager.js";
import { TodoProvider } from "./todos/todoProvider.js";
import { FileWatcher as TodoFileWatcher } from "./todos/fileWatcher.js";
import { registerLanguageModelTools as registerTodoLMTools } from "./todos/lmTools.js";
import { registerSpecLMTools } from "./copilot/lmTools.js";
import { TodoInstance } from "./todos/types.js";
import { TODO_PRESETS } from "./todos/presets.js";
import {
  SteeringEvaluator,
  SteeringCodeActionProvider,
} from "./steeringEvaluator.js";

export function activate(context: vscode.ExtensionContext): void {
  const extensionPath = context.extensionPath;

  // Initialize template loading
  initTemplates(extensionPath);
  initHooks(extensionPath);

  // Ensure cache directory is gitignored
  void ensureGitignoreEntry(".copilot-specs-cache/");
  // ── Providers ───────────────────────────────────────────────────────────────

  const specProvider = new SpecProvider();
  const steeringProvider = new SteeringProvider(
    async () => {
      const items: { name: string; filePath: string }[] = [];
      const ciUri = copilotInstructionsUri();
      if (ciUri && (await fileExists(ciUri))) {
        items.push({ name: "copilot-instructions.md", filePath: ciUri.fsPath });
      }
      const potentialInstructions = [
        resolveWorkspacePath("copilot-instructions.md"),
        resolveWorkspacePath(".github", "AGENTS.md"),
        resolveWorkspacePath("AGENTS.md"),
      ];
      for (const uri of potentialInstructions) {
        if (uri && (await fileExists(uri)) && !items.some((i) => i.filePath === uri.fsPath)) {
          items.push({ name: path.basename(uri.fsPath), filePath: uri.fsPath });
        }
      }
      const entries = await readAllSteering();
      for (const e of entries) {
        if (!items.some((i) => i.name === e.name)) {
          items.push({ name: e.name, filePath: e.filePath });
        }
      }
      return items;
    },
    async () => {
      const rules = await listInstructionRulesFiles();
      return rules.map((r) => ({ name: r.name, filePath: r.uri.fsPath }));
    },
    async () => {
      const skills = await listSkillFiles();
      return skills.map((s) => ({ name: s.name, filePath: s.uri.fsPath }));
    },
    async () => {
      const prompts = await listPromptFiles();
      return prompts.map((p) => ({ name: p.name, filePath: p.uri.fsPath }));
    },
    async () => {
      const workflows = await listWorkflowFiles();
      return workflows.map((w) => ({ name: w.name, filePath: w.uri.fsPath }));
    },
  );
  const hooksProvider = new HooksProvider(async () => {
    const hooks = await listHooks();
    return hooks.map((h) => ({
      name: h.name,
      filePath: h.filePath,
      event: h.event,
      commandIndex: h.commandIndex,
      enabled: h.enabled,
    }));
  });
  const mcpServersProvider = new MCPServersProvider(async () =>
    listMcpServers(),
  );
  const codeLensProvider = new SpecCodeLensProvider();
  const statusBar = new SpecStatusBar();

  // ── Tree Views ──────────────────────────────────────────────────────────────

  const specExplorer = vscode.window.createTreeView(
    "copilot-specs.specExplorer",
    {
      treeDataProvider: specProvider,
      showCollapseAll: true,
    },
  );

  // ── Developer Todos Setup ──────────────────────────────────────────────────
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || "";

  const gitTodoService = new GitTodoService();
  const todoManager = new TodoManager(context, gitTodoService, workspaceRoot);
  void todoManager.initialize();

  const todoProvider = new TodoProvider(todoManager, gitTodoService);
  const todoTreeView = vscode.window.createTreeView("copilot-specs.developerTodosView", {
    treeDataProvider: todoProvider,
    showCollapseAll: true,
  });

  const updateTodoTreeViewDescription = () => {
    todoTreeView.description = todoProvider.getDescription();
  };
  updateTodoTreeViewDescription();
  todoManager.onTodosChanged(updateTodoTreeViewDescription);

  const todoFileWatcher = new TodoFileWatcher(todoManager, gitTodoService);
  registerTodoLMTools(context, todoManager, gitTodoService);
  registerSpecLMTools(context);

  if (workspaceRoot && !todoManager.hasConfig()) {
    void vscode.window
      .showInformationMessage(
        "Developer Todos: No .todo.json found in workspace. Create one to get started!",
        "Create Example"
      )
      .then((selection) => {
        if (selection === "Create Example") {
          void createExampleConfig(workspaceRoot);
        }
      });
  }

  gitTodoService.onBranchChange(async (newBranch) => {
    await todoManager.switchBranch(newBranch);
    updateTodoTreeViewDescription();
  });

  vscode.window.registerTreeDataProvider(
    "copilot-specs.steeringExplorer",
    steeringProvider,
  );
  context.subscriptions.push(
    vscode.window.createTreeView("copilot-specs.hooksExplorer", {
      treeDataProvider: hooksProvider,
      showCollapseAll: false,
    }),
  );
  context.subscriptions.push(
    vscode.window.createTreeView("copilot-specs.mcpServersExplorer", {
      treeDataProvider: mcpServersProvider,
      showCollapseAll: true,
    }),
  );
  context.subscriptions.push(
    vscode.window.createTreeView("copilot-specs.mcpServersExplorerSidebar", {
      treeDataProvider: mcpServersProvider,
      showCollapseAll: true,
    }),
  );
  context.subscriptions.push(todoTreeView);
  context.subscriptions.push(gitTodoService, todoManager, todoFileWatcher);

  // ── CodeLens ────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      codeLensProvider,
    ),
  );

  // ── File System Watchers ────────────────────────────────────────────────────

  function makeWatcher(globPattern: string, refresh: () => void): void {
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(wf, globPattern),
    );
    watcher.onDidCreate(() => {
      refresh();
    });
    watcher.onDidDelete(() => {
      refresh();
    });
    watcher.onDidChange(() => {
      refresh();
    });
    context.subscriptions.push(watcher);
  }

  const refreshAll = () => {
    specProvider.refresh();
    codeLensProvider.refresh();
    updateStatusBar().catch(console.error);
  };

  let autoLinkTimer: NodeJS.Timeout | undefined;
  let autoLinkRunning = false;
  let autoLinkQueued = false;

  const runAutoLink = async (): Promise<void> => {
    if (autoLinkRunning) {
      autoLinkQueued = true;
      return;
    }
    autoLinkRunning = true;
    try {
      await linkExistingTaskToImplementation(
        { refresh: () => refreshAll() },
        { silent: true },
      );
    } catch (err) {
      console.error("Auto-linking tasks failed", err);
    } finally {
      autoLinkRunning = false;
      if (autoLinkQueued) {
        autoLinkQueued = false;
        scheduleAutoLink();
      }
    }
  };

  const scheduleAutoLink = (): void => {
    if (autoLinkTimer) {
      clearTimeout(autoLinkTimer);
    }
    autoLinkTimer = setTimeout(() => {
      void runAutoLink();
    }, 1200);
  };

  makeWatcher(`${SPECS_DIR}/**`, () => {
    refreshAll();
    scheduleAutoLink();
  });
  makeWatcher(".kiro/specs/**", () => {
    refreshAll();
    scheduleAutoLink();
  });
  makeWatcher(`${HOOKS_DIR}/**`, () => hooksProvider.refresh());
  makeWatcher(".vscode/mcp.json", () => mcpServersProvider.refresh());
  makeWatcher(".github/mcp.json", () => mcpServersProvider.refresh());
  makeWatcher(".mcp.json", () => mcpServersProvider.refresh());
  makeWatcher("mcp.json", () => mcpServersProvider.refresh());
  makeWatcher(".github/copilot-instructions.md", () =>
    steeringProvider.refresh(),
  );
  makeWatcher(`${INSTRUCTIONS_DIR}/*.instructions.md`, () =>
    steeringProvider.refresh(),
  );
  makeWatcher(".github/skills/**", () => steeringProvider.refresh());
  makeWatcher(`${PROMPTS_DIR}/**`, () => steeringProvider.refresh());
  makeWatcher(`${WORKFLOWS_DIR}/**`, () => steeringProvider.refresh());

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (shouldScheduleAutoLink(document.uri)) {
        scheduleAutoLink();
      }
      validateSpecDocument(document);
    }),
  );

  // ── Spec Markdown Diagnostics ────────────────────────────────────────────────

  const specDiagnostics =
    vscode.languages.createDiagnosticCollection("copilot-specs");
  context.subscriptions.push(specDiagnostics);

  function isSpecInstructionFile(uri: vscode.Uri): boolean {
    return (
      uri.fsPath.endsWith(".instructions.md") &&
      uri.fsPath.includes(SPECS_DIR.replace(/\//g, path.sep))
    );
  }

  function validateSpecDocument(document: vscode.TextDocument): void {
    if (!isSpecInstructionFile(document.uri)) {
      return;
    }
    const issues = validateTaskMarkdown(document.getText());
    const diagnostics = issues.map((issue) => {
      const lineText = document.lineAt(issue.line).text;
      const range = new vscode.Range(
        issue.line,
        0,
        issue.line,
        lineText.length,
      );
      return new vscode.Diagnostic(
        range,
        issue.message,
        issue.severity === "error"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
    });
    specDiagnostics.set(document.uri, diagnostics);
  }

  // Validate already-open spec files at activation time
  for (const document of vscode.workspace.textDocuments) {
    validateSpecDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      validateSpecDocument(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      validateSpecDocument(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isSpecInstructionFile(document.uri)) {
        specDiagnostics.delete(document.uri);
      }
    }),
  );

  // ── Steering Evaluator ──────────────────────────────────────────────────────

  const steeringEvaluator = new SteeringEvaluator();
  context.subscriptions.push(steeringEvaluator);

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ language: "markdown" }, { language: "json" }],
      new SteeringCodeActionProvider(),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      },
    ),
  );

  // Validate on open/save
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void steeringEvaluator.evaluateDocument(document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void steeringEvaluator.evaluateDocument(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      steeringEvaluator.collection.delete(document.uri);
    }),
  );

  // Validate existing on startup
  for (const document of vscode.workspace.textDocuments) {
    void steeringEvaluator.evaluateDocument(document);
  }

  // ── Status Bar ──────────────────────────────────────────────────────────────

  async function updateStatusBar(): Promise<void> {
    const specs = await listSpecs();
    if (specs.length === 0) {
      statusBar.hide();
      return;
    }
    // Show the first spec with the most pending tasks
    let best = specs[0];
    let bestPending = 0;
    for (const spec of specs) {
      const { tasks } = await loadTasks(spec.name);
      const prog = calculateProgress(tasks);
      const pending = prog.total - prog.completed;
      if (pending > bestPending) {
        best = spec;
        bestPending = pending;
      }
    }
    const { tasks } = await loadTasks(best.name);
    const prog = calculateProgress(tasks);
    statusBar.update(best.name, prog.completed, prog.total);
  }

  updateStatusBar().catch(console.error);

  // ── Hook Watchers ────────────────────────────────────────────────────────────

  registerHookWatchers(context, listHooks);

  // ── Chat Participant ─────────────────────────────────────────────────────────

  registerChatParticipant(
    context,
    (specName, taskId) => {
      codeLensProvider.setTaskInProgress(specName, taskId, true);
    },
    (specName, taskId) => {
      codeLensProvider.setTaskInProgress(specName, taskId, false);
      refreshAll();
    },
  );

  // ── Commands ─────────────────────────────────────────────────────────────────

  const cmds: [string, (...args: any[]) => any][] = [
    [
      "copilot-specs.newSpec",
      async () => {
        await promptCreateSpec();
        refreshAll();
      },
    ],
    [
      "copilot-specs.newBugfixSpec",
      async () => {
        await promptCreateBugfixSpec();
        refreshAll();
      },
    ],
    [
      "copilot-specs.newQuickSpec",
      async () => {
        await promptCreateQuickSpec();
        refreshAll();
      },
    ],
    [
      "copilot-specs.createSpecWizard",
      async () => {
        await promptCreateSpecWizard();
        refreshAll();
      },
    ],

    [
      "copilot-specs.openSpec",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (!name) {
          return;
        }
        const spec = await loadSpec(name);
        if (!spec) {
          return;
        }

        const reqUri = vscode.Uri.file(spec.requirementsPath);
        try {
          const doc = await vscode.workspace.openTextDocument(reqUri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to open requirements for spec "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.openSpecFile",
      async (filePathOrItem?: unknown) => {
        let filePath: string | undefined;
        if (typeof filePathOrItem === "string") {
          filePath = filePathOrItem;
        } else if (
          filePathOrItem &&
          typeof (filePathOrItem as any).filePath === "string"
        ) {
          filePath = (filePathOrItem as any).filePath;
        } else if (
          filePathOrItem &&
          typeof (filePathOrItem as any).resourceUri?.fsPath === "string"
        ) {
          filePath = (filePathOrItem as any).resourceUri.fsPath;
        }

        if (!filePath) {
          return;
        }

        const uri = vscode.Uri.file(filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to open spec file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.openSpecRequirements",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (!name) {
          return;
        }
        const spec = await loadSpec(name);
        if (!spec) {
          return;
        }
        const uri = vscode.Uri.file(spec.requirementsPath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to open requirements for spec "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.openSpecDesign",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (!name) {
          return;
        }
        const spec = await loadSpec(name);
        if (!spec) {
          return;
        }
        const uri = vscode.Uri.file(spec.designPath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to open design for spec "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.openSpecTasks",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (!name) {
          return;
        }
        const spec = await loadSpec(name);
        if (!spec) {
          return;
        }
        const uri = vscode.Uri.file(spec.tasksPath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to open tasks for spec "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.deleteSpec",
      async (item?: unknown) => {
        const name = resolveSpecName(item);
        if (!name) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete spec "${name}" and all its files?`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") {
          return;
        }
        await deleteSpec(name);
        refreshAll();
      },
    ],

    [
      "copilot-specs.renameSpec",
      async (item?: unknown) => {
        const oldName = resolveSpecName(item);
        if (!oldName) {
          return;
        }
        const newName = await vscode.window.showInputBox({
          prompt: `Rename spec "${oldName}" to:`,
          value: oldName,
          validateInput: (v) => (v.trim() ? undefined : "Name cannot be empty"),
        });
        if (!newName || newName === oldName) {
          return;
        }
        await renameSpec(oldName, newName.trim());
        refreshAll();
      },
    ],

    [
      "copilot-specs.generateWithCopilot",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        const specArg = name ? `create ${name}` : "";
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: `@spec ${specArg}`,
        });
      },
    ],

    [
      "copilot-specs.startImplementation",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (!name) {
          return;
        }
        const spec = await loadSpec(name);
        if (!spec) {
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(spec.tasksPath),
          );
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
          console.warn("Could not open tasks doc:", err);
        }
        const { tasks } = await loadTasks(name);
        const firstPending = tasks.find((t) => !t.completed) ?? tasks[0];
        if (firstPending) {
          const prompt = await buildStartTaskPrompt(name, firstPending.id);
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: prompt,
            mode: "agent",
          });
        }
      },
    ],

    [
      "copilot-specs.toggleTaskRequired",
      async (specNameArg?: unknown, taskIdArg?: unknown) => {
        let specName: string | undefined;
        let taskId: string | undefined;
        if (typeof specNameArg === "string" && typeof taskIdArg === "string") {
          specName = specNameArg;
          taskId = taskIdArg;
        } else {
          const task = resolveTask(specNameArg);
          specName = task?.specName;
          taskId = task?.id;
        }
        if (!specName || !taskId) {
          return;
        }
        const { toggleTaskRequired } = await import("./taskManager.js");
        await toggleTaskRequired(specName, taskId);
        refreshAll();
      },
    ],

    [
      "copilot-specs.runRequiredTasks",
      async (specNameOrItem?: unknown) => {
        let name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);

        if (!name) {
          const specs = await listSpecs();
          if (specs.length === 0) {
            return;
          }
          const pick = await vscode.window.showQuickPick(
            specs.map((s) => ({ label: s.name, description: s.fileGlob })),
            { placeHolder: "Select a spec to verify required tasks" },
          );
          if (!pick) {
            return;
          }
          name = pick.label;
        }

        const prompt = await buildRunAllTasksVerificationPrompt(name, true);
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: prompt,
          mode: "agent",
        });
      },
    ],

    [
      "copilot-specs.checkTask",
      async (taskItem?: unknown) => {
        const task = resolveTask(taskItem);
        if (!task) {
          return;
        }
        codeLensProvider.setTaskInProgress(task.specName, task.id, false);
        await setTaskCompleted(task.specName, task.id, true);
        refreshAll();
      },
    ],

    [
      "copilot-specs.uncheckTask",
      async (taskItem?: unknown) => {
        const task = resolveTask(taskItem);
        if (!task) {
          return;
        }
        await setTaskCompleted(task.specName, task.id, false);
        refreshAll();
      },
    ],

    [
      "copilot-specs.linkFileToTask",
      async () => {
        await linkCurrentFileToTask({ refresh: () => refreshAll() });
      },
    ],

    [
      "copilot-specs.linkExistingTaskToImplementation",
      async () => {
        await linkExistingTaskToImplementation({ refresh: () => refreshAll() });
      },
    ],

    [
      "copilot-specs.openTaskImplementations",
      async (specName?: unknown, taskId?: unknown) => {
        if (typeof specName !== "string" || typeof taskId !== "string") {
          return;
        }
        await openTaskImplementations(specName, taskId);
      },
    ],

    [
      "copilot-specs.openTaskInTasksDocument",
      async (specName?: unknown, taskId?: unknown) => {
        if (typeof specName !== "string" || typeof taskId !== "string") {
          return;
        }

        const spec = await loadSpec(specName);
        if (!spec) {
          return;
        }

        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(spec.tasksPath),
        );
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
        });

        const { tasks } = await loadTasks(specName);
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          return;
        }

        const line = Math.max(0, Math.min(task.lineIndex, doc.lineCount - 1));
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter,
        );
      },
    ],

    [
      "copilot-specs.openRequirementTasks",
      async (specName?: unknown, requirementId?: unknown) => {
        if (typeof specName !== "string" || typeof requirementId !== "string") {
          return;
        }
        await openRequirementTasks(specName, requirementId);
      },
    ],

    [
      "copilot-specs.openTaskRequirements",
      async (specName?: unknown, taskId?: unknown) => {
        if (typeof specName !== "string" || typeof taskId !== "string") {
          return;
        }
        await openTaskRequirements(specName, taskId);
      },
    ],

    [
      "copilot-specs.openTaskReferencedFiles",
      async (specName?: unknown, taskId?: unknown) => {
        if (typeof specName !== "string" || typeof taskId !== "string") {
          return;
        }
        await openTaskReferencedFiles(specName, taskId);
      },
    ],

    [
      "copilot-specs.showRequirementTaskMap",
      async (specNameOrItem?: unknown) => {
        let name = resolveSpecName(specNameOrItem);
        if (!name) {
          name = resolveSpecNameFromActiveEditor();
        }
        if (!name) {
          const specs = await listSpecs();
          if (specs.length === 0) {
            return;
          }
          const pick = await vscode.window.showQuickPick(
            specs.map((spec) => ({ label: spec.name })),
            { placeHolder: "Select a spec to debug" },
          );
          if (!pick) {
            return;
          }
          name = pick.label;
        }
        await showRequirementTaskMap(name);
      },
    ],

    [
      "copilot-specs.newSteering",
      async () => {
        await promptNewSteering();
        steeringProvider.refresh();
      },
    ],

    [
      "copilot-specs.evaluateSteeringFile",
      async (uri?: vscode.Uri) => {
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
          vscode.window.showErrorMessage("No file selected for evaluation.");
          return;
        }
        
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Evaluating Chat Customization...",
            cancellable: false,
          },
          async () => {
            const diagnostics = await steeringEvaluator.evaluateFileUri(targetUri);
            if (diagnostics.length === 0) {
              vscode.window.showInformationMessage("✅ No steering issues found!");
            } else {
              vscode.window.showWarningMessage(
                `Found ${diagnostics.length} issue(s). Check the Problems panel.`,
              );
              vscode.commands.executeCommand("workbench.action.problems.focus");
            }
          },
        );
      },
    ],

    [
      "copilot-specs.evaluateAllSteering",
      async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Evaluating All Chat Customizations...",
            cancellable: false,
          },
          async () => {
            const total = await steeringEvaluator.evaluateWorkspace();
            if (total === 0) {
              vscode.window.showInformationMessage("✅ All steering files are valid!");
            } else {
              vscode.window.showWarningMessage(
                `Found ${total} total steering issue(s). Check the Problems panel.`,
              );
              vscode.commands.executeCommand("workbench.action.problems.focus");
            }
          },
        );
      },
    ],

    [
      "copilot-specs.newPrompt",
      async () => {
        await promptNewSteering("prompt");
        steeringProvider.refresh();
      },
    ],

    [
      "copilot-specs.newWorkflow",
      async () => {
        await promptNewSteering("workflow");
        steeringProvider.refresh();
      },
    ],

    [
      "copilot-specs.editSteering",
      async () => {
        await openSteeringFile();
      },
    ],

    [
      "copilot-specs.newHook",
      async () => {
        await createHook(extensionPath);
        hooksProvider.refresh();
      },
    ],

    [
      "copilot-specs.runHook",
      async (hookItem?: unknown) => {
        if (
          hookItem &&
          typeof (hookItem as { hookName?: string }).hookName === "string"
        ) {
          const hookName = (hookItem as { hookName: string }).hookName;
          const hooks = await listHooks();
          const hook = hooks.find((h) => h.name === hookName);
          if (hook) {
            await runHook(hook);
          }
        } else {
          const hooks = await listHooks();
          if (hooks.length === 0) {
            vscode.window.showInformationMessage(
              'No hooks found. Create one with "Copilot Specs: New Agent Hook".',
            );
            return;
          }
          const pick = await vscode.window.showQuickPick(
            hooks.map((h) => ({
              label: h.name,
              description: h.event,
              hook: h,
            })),
          );
          if (pick) {
            await runHook(pick.hook);
          }
        }
      },
    ],

    [
      "copilot-specs.toggleHook",
      async (hookItem?: unknown) => {
        const hook = resolveHook(hookItem);
        if (!hook) {
          return;
        }

        const nextEnabled = !hook.enabled;
        const changed = await setHookEnabled(
          hook.filePath,
          hook.event,
          hook.commandIndex,
          nextEnabled,
        );

        if (!changed) {
          vscode.window.showWarningMessage(
            `Hook was not found at index ${hook.commandIndex} in ${hook.filePath}.`,
          );
          return;
        }

        hooksProvider.refresh();
      },
    ],

    [
      "copilot-specs.enableHook",
      async (hookItem?: unknown) => {
        const hook = resolveHook(hookItem);
        if (!hook || hook.enabled) {
          return;
        }

        const changed = await setHookEnabled(
          hook.filePath,
          hook.event,
          hook.commandIndex,
          true,
        );

        if (changed) {
          hooksProvider.refresh();
        }
      },
    ],

    [
      "copilot-specs.disableHook",
      async (hookItem?: unknown) => {
        const hook = resolveHook(hookItem);
        if (!hook || !hook.enabled) {
          return;
        }

        const changed = await setHookEnabled(
          hook.filePath,
          hook.event,
          hook.commandIndex,
          false,
        );

        if (changed) {
          hooksProvider.refresh();
        }
      },
    ],

    [
      "copilot-specs.startTask",
      async (specNameOrItem?: unknown, taskId?: unknown) => {
        // CodeLens passes (specName: string, taskId: string)
        // Tree view inline button passes a TaskItem
        let specName: string | undefined;
        let id: string | undefined;
        if (typeof specNameOrItem === "string" && typeof taskId === "string") {
          specName = specNameOrItem;
          id = taskId;
        } else {
          const task = resolveTask(specNameOrItem);
          specName = task?.specName;
          id = task?.id;
        }
        if (!specName || !id) {
          return;
        }
        // Build a rich context prompt and open it in agent mode so the
        // agent can read files, make edits, and run tests with full tool
        // access — instead of routing through the @spec chat participant
        // which only has a blind LLM call.
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Preparing task ${id}…`,
            cancellable: false,
          },
          async () => {
            const prompt = await buildStartTaskPrompt(specName!, id!);
            await vscode.commands.executeCommand("workbench.action.chat.open", {
              query: prompt,
              mode: "agent",
            });
          },
        );
      },
    ],

    [
      "copilot-specs.markTaskComplete",
      async (specNameArg?: unknown, taskIdArg?: unknown) => {
        // Called from CodeLens with (specName, taskId) or from tree with a TaskItem
        let specName: string | undefined;
        let id: string | undefined;
        if (typeof specNameArg === "string" && typeof taskIdArg === "string") {
          specName = specNameArg;
          id = taskIdArg;
        } else {
          const task = resolveTask(specNameArg);
          specName = task?.specName;
          id = task?.id;
        }
        if (!specName || !id) {
          return;
        }
        codeLensProvider.setTaskInProgress(specName, id, false);
        await markTaskAndSubtasksCompleted(specName, id, true);
        refreshAll();
      },
    ],

    [
      "copilot-specs.runAllTasks",
      async (specNameOrItem?: unknown) => {
        let name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);

        if (!name) {
          const specs = await listSpecs();
          if (specs.length === 0) {
            return;
          }

          const pick = await vscode.window.showQuickPick(
            specs.map((s) => ({ label: s.name, description: s.fileGlob })),
            { placeHolder: "Select a spec to verify all tasks" },
          );
          if (!pick) {
            return;
          }
          name = pick.label;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Preparing verification for "${name}"…`,
            cancellable: false,
          },
          async () => {
            const prompt = await buildRunAllTasksVerificationPrompt(name!);
            await vscode.commands.executeCommand(
              "workbench.action.chat.open",
              { query: prompt, mode: "agent" },
            );
          },
        );
      },
    ],

    [
      "copilot-specs.autopilot",
      async (specNameOrItem?: unknown) => {
        const name =
          typeof specNameOrItem === "string"
            ? specNameOrItem
            : resolveSpecName(specNameOrItem);
        if (name) {
          const spec = await loadSpec(name);
          if (!spec) {
            return;
          }
          const { tasks } = await loadTasks(name);
          const pending = tasks.filter((t) => !t.completed);
          if (pending.length === 0) {
            vscode.window.showInformationMessage(
              `All tasks in "${name}" are complete! 🎉`,
            );
            return;
          }
        }
        await runAutopilot();
        refreshAll();
      },
    ],

    [
      "copilot-specs.selectModel",
      async () => {
        await promptSelectModel();
      },
    ],

    [
      "copilot-specs.openWorkspaceMcpConfig",
      async () => {
        const workspaceMcpPath = getPreferredWorkspaceMcpConfigPath();
        if (!workspaceMcpPath) {
          vscode.window.showWarningMessage("No workspace folder open.");
          return;
        }

        const uri = vscode.Uri.file(workspaceMcpPath);
        let exists = true;
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          exists = false;
        }

        if (!exists) {
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(path.dirname(uri.fsPath)),
          );
          const initial = Buffer.from('{\n  "servers": {}\n}\n', "utf8");
          await vscode.workspace.fs.writeFile(uri, initial);
          mcpServersProvider.refresh();
        }

        await vscode.commands.executeCommand("vscode.open", uri);
      },
    ],

    [
      "copilot-specs.openMcpConfig",
      async () => {
        const targets = await listMcpConfigTargets();
        if (targets.length === 0) {
          vscode.window.showInformationMessage("No MCP config targets found.");
          return;
        }

        const pick = await vscode.window.showQuickPick(
          targets.map((target) => ({
            label: target.label,
            description: target.exists ? "exists" : "not found",
            detail: target.filePath,
            target,
          })),
          { placeHolder: "Select MCP config to open" },
        );

        if (!pick) {
          return;
        }

        const uri = vscode.Uri.file(pick.target.filePath);
        if (!pick.target.exists) {
          const create = await vscode.window.showInformationMessage(
            `Create ${pick.target.label}?`,
            "Create",
            "Cancel",
          );
          if (create !== "Create") {
            return;
          }

          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(path.dirname(uri.fsPath)),
          );
          const initial = Buffer.from('{\n  "servers": {}\n}\n', "utf8");
          await vscode.workspace.fs.writeFile(uri, initial);
          mcpServersProvider.refresh();
        }

        await vscode.commands.executeCommand("vscode.open", uri);
      },
    ],

    [
      "copilot-specs.focusMcpPane",
      async () => {
        try {
          await vscode.commands.executeCommand(
            "workbench.view.extension.copilot-specs-mcp-container",
          );
        } catch {
          await vscode.commands.executeCommand("workbench.action.focusPanel");
        }
      },
    ],

    [
      "copilot-specs.toggleMcpServer",
      async (mcpItem?: unknown) => {
        const server = resolveMcpServer(mcpItem);
        if (!server) {
          return;
        }

        const nextEnabled = !server.enabled;
        try {
          const changed = await setMcpServerEnabled(
            server.filePath,
            server.name,
            nextEnabled,
          );
          if (!changed) {
            vscode.window.showWarningMessage(
              `MCP server "${server.name}" was not found in ${server.filePath}.`,
            );
            return;
          }

          mcpServersProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to update MCP server "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.enableMcpServer",
      async (mcpItem?: unknown) => {
        const server = resolveMcpServer(mcpItem);
        if (!server || server.enabled) {
          return;
        }

        try {
          const changed = await setMcpServerEnabled(
            server.filePath,
            server.name,
            true,
          );
          if (changed) {
            mcpServersProvider.refresh();
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to enable MCP server "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.disableMcpServer",
      async (mcpItem?: unknown) => {
        const server = resolveMcpServer(mcpItem);
        if (!server || !server.enabled) {
          return;
        }

        try {
          const changed = await setMcpServerEnabled(
            server.filePath,
            server.name,
            false,
          );
          if (changed) {
            mcpServersProvider.refresh();
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to disable MCP server "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],

    [
      "copilot-specs.refreshExplorer",
      () => {
        refreshAll();
        steeringProvider.refresh();
        hooksProvider.refresh();
        mcpServersProvider.refresh();
        todoProvider.refresh();
      },
    ],

    // ── Developer Todos Commands ──────────────────────────────────────────────
    [
      "copilot-specs.todo.refresh",
      async () => {
        await todoManager.refreshTodos();
        vscode.window.showInformationMessage("Todos refreshed");
      },
    ],

    [
      "copilot-specs.todo.showFilterMenu",
      async () => {
        const currentMode = todoProvider.getFilterMode();
        const options = [
          { label: "$(list-unordered) All Todos", value: "all" as const, description: currentMode === "all" ? "(Current)" : "" },
          { label: "$(circle-outline) Remaining Only", value: "remaining" as const, description: currentMode === "remaining" ? "(Current)" : "" },
          { label: "$(check) Completed Only", value: "completed" as const, description: currentMode === "completed" ? "(Current)" : "" },
          { label: "$(circle-slash) Ignored Only", value: "ignored" as const, description: currentMode === "ignored" ? "(Current)" : "" },
        ];

        const selected = await vscode.window.showQuickPick(options, {
          placeHolder: "Select filter mode",
        });

        if (selected) {
          todoProvider.setFilterMode(selected.value);
          vscode.window.showInformationMessage(`Filter: ${selected.label.replace(/\$\([^)]+\)\s*/, "")}`);
        }
      },
    ],

    [
      "copilot-specs.todo.filterAll",
      () => {
        todoProvider.setFilterMode("all");
        vscode.window.showInformationMessage("Showing all todos");
      },
    ],

    [
      "copilot-specs.todo.filterRemaining",
      () => {
        todoProvider.setFilterMode("remaining");
        vscode.window.showInformationMessage("Showing remaining todos only");
      },
    ],

    [
      "copilot-specs.todo.filterCompleted",
      () => {
        todoProvider.setFilterMode("completed");
        vscode.window.showInformationMessage("Showing completed todos only");
      },
    ],

    [
      "copilot-specs.todo.filterIgnored",
      () => {
        todoProvider.setFilterMode("ignored");
        vscode.window.showInformationMessage("Showing ignored todos only");
      },
    ],

    [
      "copilot-specs.todo.navigateToFile",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          if (!todo.filePath) {
            vscode.window.showInformationMessage("This is a branch-level task (no file associated)");
            return;
          }
          try {
            const fileUri = vscode.Uri.file(todo.filePath);
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`
            );
          }
        }
      },
    ],

    [
      "copilot-specs.todo.completeTodo",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          await todoManager.completeTodo(todo.id);
          vscode.window.showInformationMessage(`Completed: ${todo.name}`);
        }
      },
    ],

    [
      "copilot-specs.todo.reopenTodo",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          await todoManager.reopenTodo(todo.id);
          vscode.window.showInformationMessage(`Reopened: ${todo.name}`);
        }
      },
    ],

    [
      "copilot-specs.todo.ignoreTodo",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          await todoManager.ignoreTodo(todo.id);
          vscode.window.showInformationMessage(`Ignored: ${todo.name}`);
        }
      },
    ],

    [
      "copilot-specs.todo.unignoreTodo",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          await todoManager.unignoreTodo(todo.id);
          vscode.window.showInformationMessage(`Unignored: ${todo.name}`);
        }
      },
    ],

    [
      "copilot-specs.todo.openFile",
      async (todoArg?: unknown) => {
        const todo = todoArg as TodoInstance | undefined;
        if (!todo || !todo.filePath) {
          return;
        }
        try {
          const fileUri = vscode.Uri.file(todo.filePath);
          const document = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(document);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      },
    ],

    [
      "copilot-specs.todo.showTemplate",
      async (item: any) => {
        if (item && item.todo) {
          const todo: TodoInstance = item.todo;
          if (todo.isManual) {
            vscode.window.showInformationMessage(
              `**${todo.name}**\n\n${todo.description}\n\nPriority: ${todo.priority}\nCreated by AI Agent`
            );
            return;
          }
          const template = todoManager
            .getTemplates()
            .find((t) => t.id === todo.templateId);

          if (template) {
            const message = `**${template.name}**\n\n${template.description}\n\n` +
              `Pattern: \`${template.applyTo || "N/A"}\`\n` +
              (template.fileContains ? `Contains: \`${template.fileContains}\`\n` : "") +
              (template.excludeFileContains ? `Excludes: \`${template.excludeFileContains}\`\n` : "") +
              `Priority: ${template.priority || "medium"}`;

            vscode.window.showInformationMessage(message);
          }
        }
      },
    ],

    [
      "copilot-specs.todo.clearBranchTodos",
      async () => {
        const branch = gitTodoService.getCurrentBranch();
        const result = await vscode.window.showWarningMessage(
          `Clear all todos for branch "${branch}"?`,
          { modal: true },
          "Clear"
        );

        if (result === "Clear") {
          await todoManager.clearBranchTodos();
          vscode.window.showInformationMessage(`Cleared todos for ${branch}`);
        }
      },
    ],

    [
      "copilot-specs.todo.openTriggeringFile",
      async (relativePathArg?: unknown) => {
        const relativePath = typeof relativePathArg === "string" ? relativePathArg : undefined;
        if (!relativePath) {
          return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder open");
          return;
        }

        try {
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
          const document = await vscode.workspace.openTextDocument(fullPath);
          await vscode.window.showTextDocument(document);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to open file: ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      },
    ],

    [
      "copilot-specs.todo.addTodo",
      async () => {
        const name = await vscode.window.showInputBox({
          prompt: "Enter task name",
          placeHolder: "e.g. Write unit tests for AuthService",
        });
        if (!name || !name.trim()) {
          return;
        }

        const description = await vscode.window.showInputBox({
          prompt: "Enter task description",
          placeHolder: "e.g. Include test cases for success and error handling",
        });
        if (!description || !description.trim()) {
          return;
        }

        const priorityPick = await vscode.window.showQuickPick(
          [
            { label: "🔴 High", value: "high" as const },
            { label: "🟡 Medium", value: "medium" as const },
            { label: "⚪ Low", value: "low" as const },
          ],
          { placeHolder: "Select priority" }
        );

        const priority = priorityPick ? priorityPick.value : "medium";
        const activeEditor = vscode.window.activeTextEditor;
        const filePath = activeEditor?.document.uri.scheme === "file" ? activeEditor.document.uri.fsPath : undefined;

        await todoManager.addManualTodo(name.trim(), description.trim(), priority, filePath);
        vscode.window.showInformationMessage(`Todo added: ${name}`);
      },
    ],

    [
      "copilot-specs.todo.createExampleConfig",
      async () => {
        await createExampleConfig(workspaceRoot);
      },
    ],

    [
      "copilot-specs.todo.selectPreset",
      async () => {
        const picks = TODO_PRESETS.map((p) => ({
          label: `${p.icon} ${p.name}`,
          description: p.description,
          preset: p,
        }));

        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select a todo template preset to generate .todo.json",
        });

        if (!selected) {
          return;
        }

        if (!workspaceRoot) {
          vscode.window.showErrorMessage("No workspace folder open");
          return;
        }

        const githubDir = path.join(workspaceRoot, ".github");
        const configPath = path.join(githubDir, "todo.json");
        try {
          const fs = await import("node:fs");
          if (!fs.existsSync(githubDir)) {
            fs.mkdirSync(githubDir, { recursive: true });
          }
          fs.writeFileSync(configPath, JSON.stringify(selected.preset.config, null, 2), "utf-8");
          vscode.window.showInformationMessage(
            `Generated .github/todo.json using "${selected.preset.name}" preset!`
          );
          await todoManager.loadTemplates();
          await todoManager.refreshTodos();
          const doc = await vscode.workspace.openTextDocument(configPath);
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to write .todo.json: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
    ],

    ["copilot-specs.createPlanPromptFile", async (specName: string, reqContent: string, designContent: string, tasksContent: string) => {
      const { createPlanPromptFile } = await import("./copilot/specGenerator.js");
      await createPlanPromptFile(specName, reqContent ?? "", designContent ?? "", tasksContent ?? "");
    }],
    ["copilot-specs.runAutopilot", async (specName?: string) => {
      const { runAutopilot } = await import("./autopilot.js");
      await runAutopilot(specName);
    }],
    ["copilot-specs.analyzeRequirements", async (specNameArg?: unknown) => {
      const specName = resolveSpecName(specNameArg) || resolveSpecNameFromActiveEditor();
      if (!specName) {
        vscode.window.showErrorMessage("Please select or open a spec requirements file first.");
        return;
      }
      const spec = await loadSpec(specName);
      if (!spec) { return; }
      const reqUri = vscode.Uri.file(spec.requirementsPath);
      const doc = await vscode.workspace.openTextDocument(reqUri);
      await vscode.window.showTextDocument(doc);
      void vscode.commands.executeCommand("workbench.action.chat.open", {
        query: `@workspace Review the requirements in .github/specs/${specName}/requirements.instructions.md for completeness, clarity, testability, and edge cases. List any ambiguities or gaps in EARS criteria.`
      });
    }],
    ["copilot-specs.syncTasks", async (specNameArg?: unknown) => {
      const specName = resolveSpecName(specNameArg) || resolveSpecNameFromActiveEditor();
      if (!specName) {
        vscode.window.showErrorMessage("Please select or open a spec first.");
        return;
      }
      void vscode.commands.executeCommand("workbench.action.chat.open", {
        query: `@workspace Based on .github/specs/${specName}/requirements.instructions.md and design.instructions.md, update and synchronize implementation tasks in .github/specs/${specName}/tasks.instructions.md.`
      });
    }],
    ["copilot-specs.checkCorrectness", async (specNameArg?: unknown) => {
      const specName = resolveSpecName(specNameArg) || resolveSpecNameFromActiveEditor();
      if (!specName) {
        vscode.window.showErrorMessage("Please select or open a spec first.");
        return;
      }
      void vscode.commands.executeCommand("workbench.action.chat.open", {
        query: `@workspace Perform a correctness audit of the codebase against requirements in .github/specs/${specName}/requirements.instructions.md. Verify each acceptance criterion.`
      });
    }],
    ["copilot-specs.jumpToNextTask", async (specNameArg?: unknown) => {
      const specName = resolveSpecName(specNameArg) || resolveSpecNameFromActiveEditor();
      if (!specName) {
        vscode.window.showErrorMessage("Please select or open a spec first.");
        return;
      }
      const { tasks } = await loadTasks(specName);
      const firstIncomplete = tasks.find((t) => !t.completed);
      const spec = await loadSpec(specName);
      if (!spec) { return; }
      const doc = await vscode.workspace.openTextDocument(spec.tasksPath);
      const editor = await vscode.window.showTextDocument(doc);
      if (firstIncomplete) {
        const pos = new vscode.Position(firstIncomplete.lineIndex, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }],

    // ── Legacy Command Aliases (for developerTodos.* compatibility) ───────────
    ["developerTodos.refresh", async () => { await todoManager.refreshTodos(); }],
    ["developerTodos.showFilterMenu", async () => { vscode.commands.executeCommand("copilot-specs.todo.showFilterMenu"); }],
    ["developerTodos.filterAll", () => { todoProvider.setFilterMode("all"); }],
    ["developerTodos.filterRemaining", () => { todoProvider.setFilterMode("remaining"); }],
    ["developerTodos.filterCompleted", () => { todoProvider.setFilterMode("completed"); }],
    ["developerTodos.filterIgnored", () => { todoProvider.setFilterMode("ignored"); }],
    ["developerTodos.completeTodo", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.completeTodo", item); }],
    ["developerTodos.reopenTodo", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.reopenTodo", item); }],
    ["developerTodos.ignoreTodo", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.ignoreTodo", item); }],
    ["developerTodos.unignoreTodo", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.unignoreTodo", item); }],
    ["developerTodos.navigateToFile", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.navigateToFile", item); }],
    ["developerTodos.openFile", async (todo: any) => { vscode.commands.executeCommand("copilot-specs.todo.openFile", todo); }],
    ["developerTodos.showTemplate", async (item: any) => { vscode.commands.executeCommand("copilot-specs.todo.showTemplate", item); }],
    ["developerTodos.clearBranchTodos", async () => { vscode.commands.executeCommand("copilot-specs.todo.clearBranchTodos"); }],
  ];

  for (const [command, handler] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler),
    );
  }

  // ── Disposables ──────────────────────────────────────────────────────────────

  context.subscriptions.push(specExplorer, statusBar);
}

export function deactivate(): void {
  // Nothing to clean up beyond subscriptions
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSpecName(item: unknown): string | undefined {
  if (!item) {
    return undefined;
  }
  // From TreeView SpecItem
  if (typeof (item as { spec?: { name?: string } }).spec?.name === "string") {
    return (item as { spec: { name: string } }).spec.name;
  }
  // From TreeView SpecFileItem
  if (typeof (item as { specName?: string }).specName === "string") {
    return (item as { specName: string }).specName;
  }
  // Direct string
  if (typeof item === "string") {
    return item;
  }
  return undefined;
}

function resolveSpecNameFromActiveEditor(): string | undefined {
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (!activeDoc) {
    return undefined;
  }
  const match = activeDoc.uri.fsPath.match(
    new RegExp(
      `${SPECS_DIR.replace(/\//g, `\\${path.sep}`)}\\${path.sep}([^\\${path.sep}]+)`,
    ),
  );
  return match ? match[1] : undefined;
}

async function createExampleConfig(workspaceRoot: string): Promise<void> {
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("No workspace open to create .github/todo.json");
    return;
  }
  const githubDir = path.join(workspaceRoot, ".github");
  const configPath = path.join(githubDir, "todo.json");

  const exampleConfig = {
    templates: [
      {
        id: "apex-permission",
        name: "Add Permission for the controller",
        description: "User needs permission to use the apex controller",
        applyTo: "force-app/main/default/classes/**/*.cls",
        fileContains: "@AuraEnabled",
        priority: "high",
        aiInstruction: "Create or update a permission set to grant access to this Apex class. Add the class to the 'Apex Class Access' section of the permission set.",
      },
      {
        id: "lwc-add-to-page",
        name: "Add LWC on a page",
        description: "The LWC needs to be added to a flexipage or similar to show up for the user",
        applyTo: "force-app/main/default/lwc/**",
        priority: "medium",
        aiInstruction: "Add the Lightning Web Component to a Lightning App Page (flexipage), Record Page, or Home Page using the Lightning App Builder.",
      },
      {
        id: "apex-test-class",
        name: "Create test class",
        description: "Add test coverage for the new Apex class",
        applyTo: "force-app/main/default/classes/**/*.cls",
        fileContains: "public class",
        excludeFileContains: "@isTest",
        priority: "high",
        aiInstruction: "Create a test class with @isTest annotation. Include test methods for all public methods. Aim for at least 75% code coverage.",
      },
      {
        id: "permission-set-to-group",
        name: "Add to permission set group",
        description: "New permission set should be added to a permission set group or assigned to users",
        applyTo: "force-app/main/default/permissionsets/**/*.permissionset-meta.xml",
        priority: "medium",
        aiInstruction: "Add this permission set to an existing permission set group, or assign it directly to users who need access to the functionality it grants.",
      },
    ],
  };

  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(githubDir)) {
      fs.mkdirSync(githubDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2), "utf-8");
    vscode.window.showInformationMessage(
      "Created example .github/todo.json. Customize it for your needs!"
    );
    const document = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to create .todo.json: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function resolveTask(item: unknown): Task | undefined {
  if (!item) {
    return undefined;
  }
  if (
    typeof (item as Task).id === "string" &&
    typeof (item as Task).specName === "string"
  ) {
    return item as Task;
  }
  // From TaskItem tree node
  if (typeof (item as TaskItem).task?.id === "string") {
    return (item as TaskItem).task;
  }
  return undefined;
}

function resolveMcpServer(
  item: unknown,
): { name: string; enabled: boolean; filePath: string } | undefined {
  if (!item) {
    return undefined;
  }

  if (
    typeof (item as { name?: unknown }).name === "string" &&
    typeof (item as { enabled?: unknown }).enabled === "boolean" &&
    typeof (item as { filePath?: unknown }).filePath === "string"
  ) {
    return {
      name: (item as { name: string }).name,
      enabled: (item as { enabled: boolean }).enabled,
      filePath: (item as { filePath: string }).filePath,
    };
  }

  if (
    typeof (item as MCPServerItem).name === "string" &&
    typeof (item as MCPServerItem).enabled === "boolean" &&
    typeof (item as MCPServerItem).filePath === "string"
  ) {
    return {
      name: (item as MCPServerItem).name,
      enabled: (item as MCPServerItem).enabled,
      filePath: (item as MCPServerItem).filePath,
    };
  }

  return undefined;
}

function resolveHook(item: unknown):
  | {
      filePath: string;
      event: HookEventName;
      commandIndex: number;
      enabled: boolean;
    }
  | undefined {
  if (!item) {
    return undefined;
  }

  if (
    typeof (item as { filePath?: unknown }).filePath === "string" &&
    typeof (item as { event?: unknown }).event === "string" &&
    typeof (item as { commandIndex?: unknown }).commandIndex === "number" &&
    typeof (item as { enabled?: unknown }).enabled === "boolean"
  ) {
    return {
      filePath: (item as { filePath: string }).filePath,
      event: (item as { event: HookEventName }).event,
      commandIndex: (item as { commandIndex: number }).commandIndex,
      enabled: (item as { enabled: boolean }).enabled,
    };
  }

  if (
    typeof (item as HookItem).filePath === "string" &&
    typeof (item as HookItem).event === "string" &&
    typeof (item as HookItem).commandIndex === "number" &&
    typeof (item as HookItem).enabled === "boolean"
  ) {
    return {
      filePath: (item as HookItem).filePath,
      event: (item as HookItem).event as HookEventName,
      commandIndex: (item as HookItem).commandIndex,
      enabled: (item as HookItem).enabled,
    };
  }

  return undefined;
}

function shouldScheduleAutoLink(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }

  const normalized = uri.fsPath.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.endsWith("/tasks.instructions.md") ||
    normalized.endsWith("/tasks.md") ||
    normalized.endsWith("/implementation-tasks.instructions.md")
  ) {
    return true;
  }

  if (
    normalized.includes("/.git/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/build/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/.vscode/")
  ) {
    return false;
  }

  if (normalized.includes("/.github/")) {
    return false;
  }

  const ext = path.extname(normalized);
  const implementationExts = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".cs",
    ".java",
    ".kt",
    ".rs",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".json",
    ".yaml",
    ".yml",
  ]);

  return implementationExts.has(ext);
}
