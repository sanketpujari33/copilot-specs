import * as vscode from "vscode";
import { TodoManager } from "./todoManager.js";
import { GitTodoService } from "./gitTodoService.js";

/**
 * Monitors file system changes and triggers todo creation
 */
export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_DELAY = 1000;

  constructor(
    private todoManager: TodoManager,
    private gitService: GitTodoService
  ) {
    this.setupWatchers();
  }

  private setupWatchers(): void {
    const createWatcher = vscode.workspace.onDidCreateFiles((event) => {
      for (const file of event.files) {
        this.handleFileChange(file.fsPath);
      }
    });

    const changeWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === "file") {
        this.handleFileChange(event.document.uri.fsPath);
      }
    });

    const saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === "file") {
        this.handleFileChange(document.uri.fsPath);
      }
    });

    this.disposables.push(createWatcher, changeWatcher, saveWatcher);

    const configWatcher = vscode.workspace.createFileSystemWatcher(
      "{**/.github/todo.json,**/.github/.todo.json,**/.todo.json}"
    );

    configWatcher.onDidChange(() => {
      void this.handleConfigChange();
    });

    configWatcher.onDidCreate(() => {
      void this.handleConfigChange();
    });

    this.disposables.push(configWatcher);

    void this.setupGitStateListener();
  }

  private async setupGitStateListener(): Promise<void> {
    let gitStateTimer: NodeJS.Timeout | undefined;
    const GIT_DEBOUNCE = 500;

    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      return;
    }

    try {
      const git = await gitExtension.activate();
      const api = git.getAPI(1);
      if (api && api.repositories.length > 0) {
        const repo = api.repositories[0];

        const stateListener = repo.state.onDidChange(() => {
          if (gitStateTimer) {
            clearTimeout(gitStateTimer);
          }

          gitStateTimer = setTimeout(() => {
            void this.todoManager.refreshTodos();
          }, GIT_DEBOUNCE);
        });

        this.disposables.push(stateListener);
      }
    } catch (error) {
      console.error("Failed to setup Git state listener:", error);
    }
  }

  private handleFileChange(filePath: string): void {
    if (filePath.endsWith(".todo.json")) {
      return;
    }

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      void this.processFileChange(filePath);
      this.debounceTimers.delete(filePath);
    }, this.DEBOUNCE_DELAY);

    this.debounceTimers.set(filePath, timer);
  }

  private async processFileChange(filePath: string): Promise<void> {
    try {
      if (!this.gitService.isFileChanged(filePath)) {
        return;
      }

      const currentBranch = this.gitService.getCurrentBranch();
      await this.todoManager.createTodosForFile(filePath, currentBranch);
    } catch (error) {
      console.error(`Error processing file change for ${filePath}:`, error);
    }
  }

  private async handleConfigChange(): Promise<void> {
    await this.todoManager.loadTemplates();
    vscode.window.showInformationMessage(
      'Todo templates reloaded. Run "Refresh Todos" to apply changes.'
    );
  }

  public dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
