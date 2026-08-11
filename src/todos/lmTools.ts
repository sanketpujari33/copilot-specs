import * as vscode from "vscode";
import { TodoManager } from "./todoManager.js";
import { GitTodoService } from "./gitTodoService.js";

interface GetRemainingTasksInput {
  priority?: "high" | "medium" | "low" | "all";
}

interface CompleteTodoInput {
  todoId: string;
}

interface GetTaskInstructionsInput {
  todoId: string;
}

interface AddTodoInput {
  name: string;
  description: string;
  priority?: "high" | "medium" | "low";
  filePath?: string;
}

/**
 * Language Model Tool: Get Remaining Tasks
 */
export class GetRemainingTasksTool implements vscode.LanguageModelTool<GetRemainingTasksInput> {
  constructor(
    private todoManager: TodoManager,
    private gitService: GitTodoService
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetRemainingTasksInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const priority = options.input.priority || "all";
    const branch = this.gitService.getCurrentBranch();

    return {
      invocationMessage: `Getting remaining tasks for branch "${branch}"${priority !== "all" ? ` (${priority} priority)` : ""}`,
      confirmationMessages: {
        title: "Get Remaining Tasks",
        message: new vscode.MarkdownString(
          `Get remaining developer tasks for branch **${branch}**` +
          (priority !== "all" ? ` filtered by **${priority}** priority` : "") +
          "?"
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetRemainingTasksInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const priority = options.input.priority || "all";
    const branch = this.gitService.getCurrentBranch();

    let todos = this.todoManager.getTodos();

    todos = todos.filter((t) => !t.completed && !t.ignored);

    if (priority !== "all") {
      todos = todos.filter((t) => t.priority === priority);
    }

    if (todos.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No remaining tasks found for branch "${branch}"` +
          (priority !== "all" ? ` with ${priority} priority` : "") +
          "."
        ),
      ]);
    }

    const result = {
      branch,
      totalRemaining: todos.length,
      tasks: todos.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        priority: t.priority,
        filePath: t.relativePath || null,
        branchLevel: t.branchLevel || false,
        triggeringFiles: t.triggeringFiles || null,
        hasAiInstruction: !!t.aiInstruction,
        isManual: t.isManual || false,
      })),
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
    ]);
  }
}

/**
 * Language Model Tool: Complete Todo
 */
export class CompleteTodoTool implements vscode.LanguageModelTool<CompleteTodoInput> {
  constructor(
    private todoManager: TodoManager
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CompleteTodoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const todoId = options.input.todoId;
    const todo = this.todoManager.getTodoById(todoId);

    if (!todo) {
      return {
        invocationMessage: `Task "${todoId}" not found`,
        confirmationMessages: {
          title: "Complete Task",
          message: new vscode.MarkdownString(`Task with ID **${todoId}** was not found.`),
        },
      };
    }

    return {
      invocationMessage: `Completing task: ${todo.name}`,
      confirmationMessages: {
        title: "Complete Task",
        message: new vscode.MarkdownString(
          `Mark the following task as **completed**?\n\n` +
          `**${todo.name}**\n\n` +
          `${todo.description}\n\n` +
          (todo.relativePath ? `File: \`${todo.relativePath}\`` : "_Branch-level task_")
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CompleteTodoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const todoId = options.input.todoId;
    const todo = this.todoManager.getTodoById(todoId);

    if (!todo) {
      throw new Error(
        `Task with ID "${todoId}" not found. Use the getRemainingTasks tool to get valid task IDs.`
      );
    }

    if (todo.completed) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Task "${todo.name}" is already completed.`
        ),
      ]);
    }

    await this.todoManager.completeTodo(todoId);

    vscode.window.showInformationMessage(`Completed: ${todo.name}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Successfully marked task "${todo.name}" as completed.`
      ),
    ]);
  }
}

/**
 * Language Model Tool: Get Task Instructions
 */
export class GetTaskInstructionsTool implements vscode.LanguageModelTool<GetTaskInstructionsInput> {
  constructor(
    private todoManager: TodoManager
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetTaskInstructionsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const todoId = options.input.todoId;
    const todo = this.todoManager.getTodoById(todoId);

    if (!todo) {
      return {
        invocationMessage: `Task "${todoId}" not found`,
        confirmationMessages: {
          title: "Get Task Instructions",
          message: new vscode.MarkdownString(`Task with ID **${todoId}** was not found.`),
        },
      };
    }

    return {
      invocationMessage: `Getting instructions for: ${todo.name}`,
      confirmationMessages: {
        title: "Get Task Instructions",
        message: new vscode.MarkdownString(
          `Get AI instructions for task **${todo.name}**?`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetTaskInstructionsInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const todoId = options.input.todoId;
    const todo = this.todoManager.getTodoById(todoId);

    if (!todo) {
      throw new Error(
        `Task with ID "${todoId}" not found. Use the getRemainingTasks tool to get valid task IDs.`
      );
    }

    const result = {
      id: todo.id,
      name: todo.name,
      description: todo.description,
      priority: todo.priority,
      filePath: todo.relativePath || null,
      branchLevel: todo.branchLevel || false,
      triggeringFiles: todo.triggeringFiles || null,
      completed: todo.completed,
      ignored: todo.ignored,
      isManual: todo.isManual || false,
      aiInstruction: todo.aiInstruction || "No specific AI instructions defined for this task. Use the description as guidance.",
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
    ]);
  }
}

/**
 * Language Model Tool: Add Todo
 */
export class AddTodoTool implements vscode.LanguageModelTool<AddTodoInput> {
  constructor(
    private todoManager: TodoManager,
    private gitService: GitTodoService
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AddTodoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const { name, description, priority = "medium", filePath } = options.input;
    const branch = this.gitService.getCurrentBranch();

    const details = [
      `**${name}**`,
      ``,
      description,
      ``,
      `Priority: **${priority}**`,
      filePath ? `File: \`${filePath}\`` : `_Branch-level task (no file)_`,
    ].join("\n");

    return {
      invocationMessage: `Adding new todo: "${name}" on branch "${branch}"`,
      confirmationMessages: {
        title: "Add New Todo",
        message: new vscode.MarkdownString(
          `Create the following new todo on branch **${branch}**?\n\n${details}`
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AddTodoInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { name, description, priority = "medium", filePath } = options.input;

    if (!name || name.trim().length === 0) {
      throw new Error('A non-empty "name" is required to create a todo.');
    }
    if (!description || description.trim().length === 0) {
      throw new Error('A non-empty "description" is required to create a todo.');
    }

    const todo = await this.todoManager.addManualTodo(
      name.trim(),
      description.trim(),
      priority,
      filePath
    );

    vscode.window.showInformationMessage(`Todo added: ${todo.name}`);

    const result = {
      id: todo.id,
      name: todo.name,
      description: todo.description,
      priority: todo.priority,
      branch: todo.branch,
      filePath: todo.relativePath || null,
      isManual: true,
      message: `Successfully created todo "${todo.name}" with ID "${todo.id}". Use this ID with completeTodo or getTaskInstructions.`,
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
    ]);
  }
}

/**
 * Language Model Tool: Complete All Branch Tasks
 */
export class CompleteAllBranchTasksTool implements vscode.LanguageModelTool<{}> {
  constructor(
    private todoManager: TodoManager,
    private gitService: GitTodoService
  ) {}

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<{}>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const branch = this.gitService.getCurrentBranch();
    const remaining = this.todoManager.getTodos().filter((t) => !t.completed && !t.ignored);

    return {
      invocationMessage: `Completing all ${remaining.length} remaining tasks for branch "${branch}"`,
      confirmationMessages: {
        title: "Complete All Branch Tasks",
        message: new vscode.MarkdownString(
          `Mark all **${remaining.length}** remaining tasks as completed on branch **${branch}**?`
        ),
      },
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<{}>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const branch = this.gitService.getCurrentBranch();
    const todos = this.todoManager.getTodos().filter((t) => !t.completed && !t.ignored);

    for (const todo of todos) {
      await this.todoManager.completeTodo(todo.id);
    }

    vscode.window.showInformationMessage(`Completed all ${todos.length} tasks for branch "${branch}"`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Successfully marked all ${todos.length} tasks as completed for branch "${branch}".`
      ),
    ]);
  }
}

/**
 * Register all language model tools
 */
export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  todoManager: TodoManager,
  gitService: GitTodoService
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(
      "developerTodos_getRemainingTasks",
      new GetRemainingTasksTool(todoManager, gitService)
    )
  );

  context.subscriptions.push(
    vscode.lm.registerTool(
      "developerTodos_completeTodo",
      new CompleteTodoTool(todoManager)
    )
  );

  context.subscriptions.push(
    vscode.lm.registerTool(
      "developerTodos_getTaskInstructions",
      new GetTaskInstructionsTool(todoManager)
    )
  );

  context.subscriptions.push(
    vscode.lm.registerTool(
      "developerTodos_addTodo",
      new AddTodoTool(todoManager, gitService)
    )
  );

  context.subscriptions.push(
    vscode.lm.registerTool(
      "developerTodos_completeAllBranchTasks",
      new CompleteAllBranchTasksTool(todoManager, gitService)
    )
  );

  console.log("Copilot Specs: Developer todos language model tools registered");
}
