import * as vscode from "vscode";
import { TodoInstance, PriorityGroup } from "./types.js";
import { TodoManager } from "./todoManager.js";
import { GitTodoService } from "./gitTodoService.js";

/**
 * Tree item that can be either a priority group, todo item, description, or triggering file
 */
export class TodoTreeItem extends vscode.TreeItem {
  public readonly filePath?: string;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: "group" | "todoItem" | "description" | "triggeringFile",
    public readonly todo?: TodoInstance,
    filePath?: string
  ) {
    super(label, collapsibleState);
    this.filePath = filePath;

    if (itemType === "todoItem" && todo) {
      if (todo.ignored) {
        this.contextValue = todo.branchLevel ? "todoItemIgnoredBranchLevel" : "todoItemIgnored";
        this.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      } else if (todo.completed) {
        this.contextValue = todo.branchLevel ? "todoItemCompletedBranchLevel" : "todoItemCompleted";
        this.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
      } else {
        this.contextValue = todo.branchLevel ? "todoItemBranchLevel" : "todoItem";
        this.iconPath = new vscode.ThemeIcon("circle-large-outline");
      }

      if (todo.branchLevel) {
        const fileCount = todo.triggeringFiles?.length || 0;
        if (fileCount > 0) {
          this.description = `(${fileCount} file${fileCount > 1 ? "s" : ""})${todo.isManual ? " [AI]" : ""}`;
          this.tooltip = `${todo.description}\n\nTriggered by ${fileCount} file${fileCount > 1 ? "s" : ""}`;
        } else {
          this.description = `(branch task)${todo.isManual ? " [AI]" : ""}`;
          this.tooltip = `${todo.description}\n\nThis is a branch-level task (not tied to a specific file)`;
        }
      } else {
        this.description = `${todo.relativePath || ""}${todo.isManual ? " [AI]" : ""}`;
        this.tooltip = `${todo.description}\n\nFile: ${todo.relativePath || "(none)"}`;
      }
    } else if (itemType === "description") {
      this.contextValue = "description";
      this.iconPath = new vscode.ThemeIcon("info");
    } else if (itemType === "triggeringFile") {
      this.contextValue = "triggeringFile";
      this.iconPath = new vscode.ThemeIcon("file");
      this.tooltip = `Click to open: ${filePath}`;
      if (filePath) {
        this.command = {
          command: "copilot-specs.todo.openTriggeringFile",
          title: "Open File",
          arguments: [filePath],
        };
      }
    } else if (itemType === "group") {
      this.contextValue = "group";
    }
  }
}

export type FilterMode = "all" | "remaining" | "completed" | "ignored";

/**
 * Tree data provider for the Developer Todos view
 */
export class TodoProvider implements vscode.TreeDataProvider<TodoTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TodoTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private filterMode: FilterMode = "remaining";

  constructor(
    private todoManager: TodoManager,
    private gitService: GitTodoService
  ) {
    this.todoManager.onTodosChanged(() => {
      this.refresh();
    });
  }

  public setFilterMode(mode: FilterMode): void {
    this.filterMode = mode;
    this.refresh();
  }

  public getFilterMode(): FilterMode {
    return this.filterMode;
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: TodoTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: TodoTreeItem): Thenable<TodoTreeItem[]> {
    if (!this.todoManager.hasConfig() && this.todoManager.getTodos().length === 0) {
      return Promise.resolve([]);
    }

    if (!element) {
      return Promise.resolve(this.getPriorityGroups());
    }

    if (element.itemType === "group") {
      return Promise.resolve(this.getTodosForGroup(element.label));
    }

    if (element.itemType === "todoItem" && element.todo) {
      const children: TodoTreeItem[] = [];

      children.push(
        new TodoTreeItem(
          element.todo.description,
          vscode.TreeItemCollapsibleState.None,
          "description",
          element.todo
        )
      );

      if (element.todo.branchLevel && element.todo.triggeringFiles && element.todo.triggeringFiles.length > 0) {
        for (const filePath of element.todo.triggeringFiles) {
          children.push(
            new TodoTreeItem(
              filePath,
              vscode.TreeItemCollapsibleState.None,
              "triggeringFile",
              element.todo,
              filePath
            )
          );
        }
      }

      return Promise.resolve(children);
    }

    return Promise.resolve([]);
  }

  private getPriorityGroups(): TodoTreeItem[] {
    const todos = this.todoManager.getTodos();
    const currentBranch = this.gitService.getCurrentBranch();

    const groups: PriorityGroup[] = [
      {
        priority: "high",
        label: "High Priority",
        icon: "🔴",
        todos: todos.filter((t) => t.priority === "high"),
      },
      {
        priority: "medium",
        label: "Medium Priority",
        icon: "🟡",
        todos: todos.filter((t) => t.priority === "medium"),
      },
      {
        priority: "low",
        label: "Low Priority",
        icon: "⚪",
        todos: todos.filter((t) => t.priority === "low"),
      },
    ];

    const items: TodoTreeItem[] = [];

    for (const group of groups) {
      const remaining = group.todos.filter((t) => !t.completed && !t.ignored);
      const completed = group.todos.filter((t) => t.completed);
      const ignored = group.todos.filter((t) => t.ignored);

      let displayCount = 0;
      if (this.filterMode === "all") {
        displayCount = group.todos.length;
      } else if (this.filterMode === "remaining") {
        displayCount = remaining.length;
      } else if (this.filterMode === "completed") {
        displayCount = completed.length;
      } else if (this.filterMode === "ignored") {
        displayCount = ignored.length;
      }

      if (displayCount > 0) {
        const label = `${group.icon} ${group.label} (${remaining.length}${this.filterMode === "all" ? `/${group.todos.length}` : ""})`;
        items.push(
          new TodoTreeItem(
            label,
            vscode.TreeItemCollapsibleState.Expanded,
            "group"
          )
        );
      }
    }

    if (items.length === 0) {
      const emptyItem = new TodoTreeItem(
        `No todos for ${currentBranch}`,
        vscode.TreeItemCollapsibleState.None,
        "group"
      );
      emptyItem.iconPath = new vscode.ThemeIcon("pass");
      emptyItem.description = "All done!";
      items.push(emptyItem);
    }

    return items;
  }

  private getTodosForGroup(groupLabel: string): TodoTreeItem[] {
    const todos = this.todoManager.getTodos();

    let priority: "high" | "medium" | "low";
    if (groupLabel.includes("High")) {
      priority = "high";
    } else if (groupLabel.includes("Medium")) {
      priority = "medium";
    } else {
      priority = "low";
    }

    const allTodos = todos.filter((t) => t.priority === priority);

    const active = allTodos.filter((t) => !t.completed && !t.ignored);
    const completed = allTodos.filter((t) => t.completed && !t.ignored);
    const ignored = allTodos.filter((t) => t.ignored);

    let todosToShow: TodoInstance[] = [];
    if (this.filterMode === "all") {
      todosToShow = [...active, ...completed, ...ignored];
    } else if (this.filterMode === "remaining") {
      todosToShow = active;
    } else if (this.filterMode === "completed") {
      todosToShow = completed;
    } else if (this.filterMode === "ignored") {
      todosToShow = ignored;
    }

    return todosToShow.map((todo) => {
      return new TodoTreeItem(
        todo.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        "todoItem",
        todo
      );
    });
  }

  public getDescription(): string {
    const branch = this.gitService.getCurrentBranch();
    const todos = this.todoManager.getTodos();
    const activeTodos = todos.filter((t) => !t.completed && !t.ignored);

    return `[${branch}] ${activeTodos.length} active`;
  }
}
