import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { TodoConfig, TodoTemplate, TodoInstance, TodoState } from "./types.js";
import { TemplateMatcher, matchGlob } from "./templateMatcher.js";
import { GitTodoService } from "./gitTodoService.js";

/**
 * Manages todo instances and state across branches
 */
export class TodoManager {
  private templates: TodoTemplate[] = [];
  private todos: Map<string, Map<string, TodoInstance>> = new Map(); // branch -> todoId -> TodoInstance
  private templateMatcher: TemplateMatcher;
  private gitService: GitTodoService;
  private context: vscode.ExtensionContext;
  private workspaceRoot: string;

  private onTodosChangedEmitter = new vscode.EventEmitter<void>();
  public readonly onTodosChanged = this.onTodosChangedEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    gitService: GitTodoService,
    workspaceRoot: string
  ) {
    this.context = context;
    this.gitService = gitService;
    this.workspaceRoot = workspaceRoot;
    this.templateMatcher = new TemplateMatcher();
  }

  /**
   * Initialize by loading templates and existing state
   */
  public async initialize(): Promise<void> {
    await this.loadTemplates();
    await this.loadState();
    await this.createBranchLevelTodos();
  }

  /**
   * Get configuration file path (prioritizing .github/todo.json)
   */
  public getConfigPath(): string {
    const paths = [
      path.join(this.workspaceRoot, ".github", "todo.json"),
      path.join(this.workspaceRoot, ".github", ".todo.json"),
      path.join(this.workspaceRoot, ".todo.json"),
    ];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return path.join(this.workspaceRoot, ".github", "todo.json");
  }

  /**
   * Load templates from configuration file
   */
  public async loadTemplates(): Promise<boolean> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      console.warn("No todo configuration found in .github/ or workspace root");
      this.templates = [];
      return false;
    }

    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const config: TodoConfig = JSON.parse(content);

      if (!config.templates || !Array.isArray(config.templates)) {
        vscode.window.showErrorMessage(
          "Invalid .todo.json: templates array is required"
        );
        this.templates = [];
        return false;
      }

      this.templates = config.templates;
      console.log(`Loaded ${this.templates.length} todo templates`);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to load .todo.json: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      this.templates = [];
      return false;
    }
  }

  /**
   * Load persisted state from workspace storage
   */
  private async loadState(): Promise<void> {
    const state = this.context.workspaceState.get<TodoState>("todoState", {});

    for (const [branch, branchData] of Object.entries(state)) {
      const branchTodos = new Map<string, TodoInstance>();

      for (const [todoId, todoData] of Object.entries(branchData.todos)) {
        if (todoData.isManual) {
          branchTodos.set(todoId, {
            id: todoId,
            templateId: todoData.templateId,
            name: todoData.name || "Manual Task",
            description: todoData.description || "",
            filePath: todoData.filePath,
            relativePath: todoData.filePath
              ? path.relative(this.workspaceRoot, todoData.filePath)
              : undefined,
            priority: todoData.priority || "medium",
            completed: todoData.completed,
            completedAt: todoData.completedAt,
            ignored: todoData.ignored || false,
            ignoredAt: todoData.ignoredAt,
            branch,
            branchLevel: todoData.branchLevel,
            triggeringFiles: todoData.triggeringFiles,
            isManual: true,
          });
          continue;
        }

        const template = this.templates.find((t) => t.id === todoData.templateId);

        if (!template) {
          continue;
        }

        const isBranchLevel = todoData.branchLevel || !todoData.filePath;
        const relativePath = isBranchLevel
          ? undefined
          : path.relative(this.workspaceRoot, todoData.filePath!);

        branchTodos.set(todoId, {
          id: todoId,
          templateId: template.id,
          name: template.name,
          description: template.description,
          filePath: todoData.filePath,
          relativePath,
          priority: template.priority || "medium",
          completed: todoData.completed,
          completedAt: todoData.completedAt,
          ignored: todoData.ignored || false,
          ignoredAt: todoData.ignoredAt,
          branch,
          branchLevel: isBranchLevel,
          triggeringFiles: todoData.triggeringFiles,
          aiInstruction: template.aiInstruction,
        });
      }

      this.todos.set(branch, branchTodos);
    }
  }

  /**
   * Save current state to workspace storage
   */
  private async saveState(): Promise<void> {
    const state: TodoState = {};

    for (const [branch, branchTodos] of this.todos.entries()) {
      state[branch] = { todos: {} };

      for (const [todoId, todo] of branchTodos.entries()) {
        state[branch].todos[todoId] = {
          completed: todo.completed,
          completedAt: todo.completedAt,
          ignored: todo.ignored,
          ignoredAt: todo.ignoredAt,
          filePath: todo.filePath,
          templateId: todo.templateId,
          branchLevel: todo.branchLevel,
          triggeringFiles: todo.triggeringFiles,
          ...(todo.isManual && {
            isManual: true,
            name: todo.name,
            description: todo.description,
            priority: todo.priority,
          }),
        };
      }
    }

    await this.context.workspaceState.update("todoState", state);
  }

  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
      ".pdf", ".zip", ".tar", ".gz", ".rar", ".7z",
      ".exe", ".dll", ".so", ".dylib",
      ".mp3", ".mp4", ".avi", ".mov", ".wav",
      ".ttf", ".otf", ".woff", ".woff2", ".eot",
      ".class", ".jar", ".war",
    ];

    const ext = path.extname(filePath).toLowerCase();
    return binaryExtensions.includes(ext);
  }

  public async createTodosForFile(
    filePath: string,
    branch?: string
  ): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const relativePath = path.relative(this.workspaceRoot, filePath);

    if (this.isBinaryFile(filePath)) {
      return;
    }

    if (!this.templateMatcher.pathMatchesAnyTemplate(relativePath, this.templates)) {
      const branchLevelWithApplyTo = this.templates.filter(
        (t) => t.branchLevel && t.applyTo
      );
      if (!this.templateMatcher.pathMatchesAnyTemplate(relativePath, branchLevelWithApplyTo.map(t => ({ ...t, branchLevel: false })))) {
        return;
      }
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
      return;
    }

    if (!this.todos.has(currentBranch)) {
      this.todos.set(currentBranch, new Map());
    }

    const branchTodos = this.todos.get(currentBranch)!;
    let todosChanged = false;

    for (const template of this.templates) {
      if (!template.applyTo) {
        continue;
      }

      if (!matchGlob(relativePath, template.applyTo)) {
        continue;
      }

      if (template.fileContains && !content.includes(template.fileContains)) {
        continue;
      }
      if (template.excludeFileContains && content.includes(template.excludeFileContains)) {
        continue;
      }

      if (template.branchLevel) {
        const todoId = `branch:${template.id}`;
        let todo = branchTodos.get(todoId);

        if (!todo) {
          todo = {
            id: todoId,
            templateId: template.id,
            name: template.name,
            description: template.description,
            priority: template.priority || "medium",
            completed: false,
            ignored: false,
            branch: currentBranch,
            branchLevel: true,
            triggeringFiles: [relativePath],
            aiInstruction: template.aiInstruction,
          };
          branchTodos.set(todoId, todo);
          todosChanged = true;
        } else {
          if (!todo.triggeringFiles) {
            todo.triggeringFiles = [];
          }
          if (!todo.triggeringFiles.includes(relativePath)) {
            todo.triggeringFiles.push(relativePath);
            todosChanged = true;
          }
        }
      } else {
        const todoId = `${template.id}:${relativePath}`;

        if (branchTodos.has(todoId)) {
          continue;
        }

        const todo: TodoInstance = {
          id: todoId,
          templateId: template.id,
          name: template.name,
          description: template.description,
          filePath,
          relativePath,
          priority: template.priority || "medium",
          completed: false,
          ignored: false,
          branch: currentBranch,
          aiInstruction: template.aiInstruction,
        };

        branchTodos.set(todoId, todo);
        todosChanged = true;
      }
    }

    if (todosChanged) {
      await this.saveState();
      this.onTodosChangedEmitter.fire();
    }
  }

  public getTodoById(todoId: string, branch?: string): TodoInstance | undefined {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return undefined;
    }

    return branchTodos.get(todoId);
  }

  public async completeTodo(todoId: string, branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return;
    }

    const todo = branchTodos.get(todoId);
    if (!todo) {
      return;
    }

    todo.completed = true;
    todo.completedAt = new Date().toISOString();

    await this.saveState();
    this.onTodosChangedEmitter.fire();
  }

  public async reopenTodo(todoId: string, branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return;
    }

    const todo = branchTodos.get(todoId);
    if (!todo) {
      return;
    }

    todo.completed = false;
    todo.completedAt = undefined;

    await this.saveState();
    this.onTodosChangedEmitter.fire();
  }

  public async ignoreTodo(todoId: string, branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return;
    }

    const todo = branchTodos.get(todoId);
    if (!todo) {
      return;
    }

    todo.ignored = true;
    todo.ignoredAt = new Date().toISOString();

    await this.saveState();
    this.onTodosChangedEmitter.fire();
  }

  public async unignoreTodo(todoId: string, branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return;
    }

    const todo = branchTodos.get(todoId);
    if (!todo) {
      return;
    }

    todo.ignored = false;
    todo.ignoredAt = undefined;

    await this.saveState();
    this.onTodosChangedEmitter.fire();
  }

  public getTodos(branch?: string): TodoInstance[] {
    const currentBranch = branch || this.gitService.getCurrentBranch();
    const branchTodos = this.todos.get(currentBranch);

    if (!branchTodos) {
      return [];
    }

    return Array.from(branchTodos.values());
  }

  public getAllBranchTodos(): Map<string, TodoInstance[]> {
    const result = new Map<string, TodoInstance[]>();

    for (const [branch, branchTodos] of this.todos.entries()) {
      result.set(branch, Array.from(branchTodos.values()));
    }

    return result;
  }

  public async createBranchLevelTodos(branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();

    if (!this.todos.has(currentBranch)) {
      this.todos.set(currentBranch, new Map());
    }

    const branchTodos = this.todos.get(currentBranch)!;
    let todosChanged = false;

    const branchLevelTemplates = this.templates.filter(
      (t) => t.branchLevel === true || !t.applyTo
    );

    for (const template of branchLevelTemplates) {
      const todoId = `branch:${template.id}`;
      const existingTodo = branchTodos.get(todoId);

      if (existingTodo) {
        if (template.applyTo) {
          const newTriggeringFiles = await this.findTriggeringFiles(template);
          if (newTriggeringFiles.length > 0) {
            const existingFiles = existingTodo.triggeringFiles || [];
            const allFiles = [...new Set([...existingFiles, ...newTriggeringFiles])];
            if (allFiles.length !== existingFiles.length) {
              existingTodo.triggeringFiles = allFiles;
              todosChanged = true;
            }
          }
        }
        continue;
      }

      const triggeringFiles = template.applyTo
        ? await this.findTriggeringFiles(template)
        : undefined;

      if (template.applyTo && (!triggeringFiles || triggeringFiles.length === 0)) {
        continue;
      }

      const todo: TodoInstance = {
        id: todoId,
        templateId: template.id,
        name: template.name,
        description: template.description,
        priority: template.priority || "medium",
        completed: false,
        ignored: false,
        branch: currentBranch,
        branchLevel: true,
        triggeringFiles,
        aiInstruction: template.aiInstruction,
      };

      branchTodos.set(todoId, todo);
      todosChanged = true;
    }

    if (todosChanged) {
      await this.saveState();
      this.onTodosChangedEmitter.fire();
    }
  }

  private async findTriggeringFiles(template: TodoTemplate): Promise<string[]> {
    if (!template.applyTo) {
      return [];
    }

    const changedFiles = this.gitService.getChangedFiles();
    const triggeringFiles: string[] = [];

    for (const filePath of changedFiles) {
      if (this.isBinaryFile(filePath)) {
        continue;
      }

      const relativePath = path.relative(this.workspaceRoot, filePath);

      if (!matchGlob(relativePath, template.applyTo)) {
        continue;
      }

      if (template.fileContains || template.excludeFileContains) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          if (template.fileContains && !content.includes(template.fileContains)) {
            continue;
          }
          if (template.excludeFileContains && content.includes(template.excludeFileContains)) {
            continue;
          }
        } catch {
          continue;
        }
      }

      triggeringFiles.push(relativePath);
    }

    return triggeringFiles;
  }

  public async refreshTodos(branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();

    await this.createBranchLevelTodos(currentBranch);

    let filesToScan = this.gitService.getChangedFiles();

    // If git has no uncommitted changes, scan existing files in workspace matching template glob patterns
    if (filesToScan.length === 0) {
      const fileSet = new Set<string>();
      for (const template of this.templates) {
        if (template.applyTo && !template.branchLevel) {
          try {
            const uris = await vscode.workspace.findFiles(template.applyTo, "**/node_modules/**", 100);
            for (const uri of uris) {
              fileSet.add(uri.fsPath);
            }
          } catch {
            // Ignore pattern errors
          }
        }
      }
      filesToScan = Array.from(fileSet);
    }

    for (const filePath of filesToScan) {
      await this.createTodosForFile(filePath, currentBranch);
    }

    this.onTodosChangedEmitter.fire();
  }

  public async clearBranchTodos(branch?: string): Promise<void> {
    const currentBranch = branch || this.gitService.getCurrentBranch();

    this.todos.delete(currentBranch);
    await this.saveState();
    this.onTodosChangedEmitter.fire();
  }

  public async switchBranch(_newBranch: string): Promise<void> {
    this.onTodosChangedEmitter.fire();
  }

  public hasConfig(): boolean {
    const paths = [
      path.join(this.workspaceRoot, ".github", "todo.json"),
      path.join(this.workspaceRoot, ".github", ".todo.json"),
      path.join(this.workspaceRoot, ".todo.json"),
    ];
    return paths.some((p) => fs.existsSync(p));
  }

  public getTemplates(): TodoTemplate[] {
    return this.templates;
  }

  public async addManualTodo(
    name: string,
    description: string,
    priority: "high" | "medium" | "low" = "medium",
    filePath?: string,
    branch?: string
  ): Promise<TodoInstance> {
    const currentBranch = branch || this.gitService.getCurrentBranch();

    if (!this.todos.has(currentBranch)) {
      this.todos.set(currentBranch, new Map());
    }

    const branchTodos = this.todos.get(currentBranch)!;

    const uniquePart = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const todoId = `manual:${uniquePart}`;

    const relativePath = filePath
      ? path.relative(this.workspaceRoot, filePath)
      : undefined;

    const todo: TodoInstance = {
      id: todoId,
      templateId: todoId,
      name,
      description,
      filePath,
      relativePath,
      priority,
      completed: false,
      ignored: false,
      branch: currentBranch,
      isManual: true,
    };

    branchTodos.set(todoId, todo);
    await this.saveState();
    this.onTodosChangedEmitter.fire();

    return todo;
  }

  public dispose() {
    this.onTodosChangedEmitter.dispose();
  }
}
