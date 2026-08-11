import * as vscode from "vscode";
import { Spec, Task, TaskProgress } from "./models/index.js";
import { listSpecs } from "./specManager.js";
import { loadTasks, calculateProgress } from "./taskManager.js";

// ── Tree Item Types ───────────────────────────────────────────────────────────

export class SpecItem extends vscode.TreeItem {
  constructor(
    public readonly spec: Spec,
    public readonly progress: TaskProgress,
  ) {
    super(spec.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = `spec-${spec.specType}`;

    // Icon: prefer progress-based, but fall back to spec-type icons when no tasks
    if (progress.total === 0) {
      const emptyIcons: Record<string, string> = {
        feature: "file-text",
        bugfix: "bug",
        quick: "zap",
      };
      this.iconPath = new vscode.ThemeIcon(
        emptyIcons[spec.specType] ?? "file-text",
        new vscode.ThemeColor("descriptionForeground"),
      );
    } else if (progress.completed === progress.total) {
      this.iconPath = new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("charts.green"),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "circle-large-outline",
        new vscode.ThemeColor("charts.orange"),
      );
    }

    const pct =
      progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;

    // Type badge in description: [feature] 72%  |  [bugfix]  |  [quick] 100%
    const typeBadge: Record<string, string> = {
      feature: "feature",
      bugfix: "bugfix",
      quick: "quick",
    };
    const badge = typeBadge[spec.specType] ?? spec.specType;
    this.description =
      progress.total > 0 ? `[${badge}] ${pct}%` : `[${badge}]`;

    const workflowLabel: Record<string, string> = {
      "requirements-first": "Requirements-First",
      "tech-design-first": "Design-First",
      quick: "Quick",
    };
    const phaseBreakdown =
      progress.phases && progress.phases.length > 0
        ? `\n\n📌 **Phases**:\n` +
          progress.phases
            .map((p) => `- ${p.name}: **${p.completed}/${p.total}**`)
            .join("\n")
        : "";

    this.tooltip = new vscode.MarkdownString(
      `**${spec.name}**\n\n` +
      `📁 \`.github/specs/${spec.name}/\`\n\n` +
      `🏷️ Type: **${badge}** · Workflow: **${workflowLabel[spec.workflowType] ?? spec.workflowType}**\n\n` +
      `🔗 Glob: \`${spec.fileGlob}\`\n\n` +
      `✅ ${progress.completed}/${progress.total} tasks complete${phaseBreakdown}`,
    );
    this.command = {
      command: "copilot-specs.openSpec",
      title: "Open Spec",
      arguments: [spec.name],
    };
  }
}


export class SpecFileItem extends vscode.TreeItem {
  constructor(
    public readonly specName: string,
    public readonly fileType: "requirements" | "design" | "tasks",
    public readonly filePath: string,
    specType: "feature" | "bugfix" | "quick" = "feature",
  ) {
    // Labels change for bugfix specs
    const labels: Record<"requirements" | "design" | "tasks", string> =
      specType === "bugfix"
        ? { requirements: "Bug Analysis", design: "Fix Plan", tasks: "Tasks" }
        : { requirements: "Requirements", design: "Design", tasks: "Tasks" };

    const icons = {
      requirements: specType === "bugfix" ? "search" : "list-ordered",
      design: specType === "bugfix" ? "tools" : "symbol-structure",
      tasks: "checklist",
    };
    const fileNames = {
      requirements: "requirements.instructions.md",
      design: "design.instructions.md",
      tasks: "tasks.instructions.md",
    };
    super(labels[fileType], vscode.TreeItemCollapsibleState.None);
    this.contextValue = `specFile-${fileType}`;
    const iconColors: Record<"requirements" | "design" | "tasks", string> = {
      requirements: "charts.blue",
      design: "charts.orange",
      tasks: "charts.green",
    };
    this.iconPath = new vscode.ThemeIcon(
      icons[fileType],
      new vscode.ThemeColor(iconColors[fileType]),
    );
    this.tooltip = new vscode.MarkdownString(
      `**${labels[fileType]}**\n\n📄 \`.github/specs/${specName}/${fileNames[fileType]}\``,
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "copilot-specs.openSpecFile",
      title: "Open File",
      arguments: [filePath],
    };

  }
}

export class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: Task) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.contextValue = task.completed ? "task-complete" : "task-incomplete";
    
    if (task.completed) {
      this.iconPath = new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("charts.green"),
      );
    } else if (task.inProgress) {
      this.iconPath = new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("charts.blue"),
      );
    } else if (task.queued) {
      this.iconPath = new vscode.ThemeIcon(
        "clock",
        new vscode.ThemeColor("charts.yellow"),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "circle-large-outline",
        new vscode.ThemeColor("charts.orange"),
      );
    }
    
    this.description = task.optional ? `${task.id} (Optional)` : task.id;
    this.tooltip = `[${task.specName}] ${task.id}: ${task.title}${task.optional ? " (Optional)" : ""}`;
    this.command = {
      command: task.completed
        ? "copilot-specs.uncheckTask"
        : "copilot-specs.checkTask",
      title: "Toggle Task",
      arguments: [task],
    };
  }
}

// ── Spec Explorer (main tree) ─────────────────────────────────────────────────

export class SpecProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Root: list all specs
      const specs = await listSpecs();
      const items: SpecItem[] = [];
      for (const spec of specs) {
        const { tasks } = await loadTasks(spec.name);
        const progress = calculateProgress(tasks);
        items.push(new SpecItem(spec, progress));
      }
      return items;
    }

    if (element instanceof SpecItem) {
      const spec = element.spec;
      return [
        new SpecFileItem(spec.name, "requirements", spec.requirementsPath, spec.specType),
        new SpecFileItem(spec.name, "design", spec.designPath, spec.specType),
        new SpecFileItem(spec.name, "tasks", spec.tasksPath, spec.specType),
      ];
    }

    return [];
  }
}

// ── Instructions, Rules & Skills Explorer ───────────────────────────────────

export class SteeringItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly filePath: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "steeringEntry";
    this.iconPath = new vscode.ThemeIcon(
      "symbol-namespace",
      new vscode.ThemeColor("charts.blue"),
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class SkillItem extends vscode.TreeItem {
  constructor(
    public readonly skillName: string,
    public readonly filePath: string,
  ) {
    super(skillName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "skill";
    this.iconPath = new vscode.ThemeIcon(
      "sparkle",
      new vscode.ThemeColor("charts.purple"),
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open Skill",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class PromptItem extends vscode.TreeItem {
  constructor(
    public readonly promptName: string,
    public readonly filePath: string,
  ) {
    super(promptName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "prompt";
    this.iconPath = new vscode.ThemeIcon(
      "comment-discussion",
      new vscode.ThemeColor("charts.yellow"),
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open Prompt",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class RulesFileItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly filePath: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "rulesFile";
    this.iconPath = new vscode.ThemeIcon(
      "symbol-ruler",
      new vscode.ThemeColor("charts.orange"),
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open Rules File",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class WorkflowItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly filePath: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "workflow";
    this.iconPath = new vscode.ThemeIcon(
      "play-circle",
      new vscode.ThemeColor("charts.green"),
    );
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open Workflow File",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class SectionItem extends vscode.TreeItem {
  constructor(
    public readonly kind: "instructions" | "rules" | "skills" | "prompts" | "workflows",
    label: string,
    icon: string,
    childCount: number,
  ) {
    super(
      label,
      childCount > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = `section-${kind}`;
    const sectionColors: Record<typeof kind, string> = {
      instructions: "charts.blue",
      rules: "charts.orange",
      skills: "charts.purple",
      prompts: "charts.yellow",
      workflows: "charts.green",
    };
    this.iconPath = new vscode.ThemeIcon(
      icon,
      new vscode.ThemeColor(sectionColors[kind]),
    );
    this.description = childCount > 0 ? `${childCount}` : "";
  }
}

export class SteeringProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly getInstructions: () => Promise<
      { name: string; filePath: string }[]
    >,
    private readonly getRules: () => Promise<
      { name: string; filePath: string }[]
    >,
    private readonly getSkills: () => Promise<
      { name: string; filePath: string }[]
    >,
    private readonly getPrompts: () => Promise<
      { name: string; filePath: string }[]
    > = async () => [],
    private readonly getWorkflows: () => Promise<
      { name: string; filePath: string }[]
    > = async () => [],
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof SectionItem) {
      switch (element.kind) {
        case "instructions":
          return (await this.getInstructions()).map(
            (e) => new SteeringItem(e.name, e.filePath),
          );
        case "rules":
          return (await this.getRules()).map(
            (r) => new RulesFileItem(r.name, r.filePath),
          );
        case "skills":
          return (await this.getSkills()).map(
            (s) => new SkillItem(s.name, s.filePath),
          );
        case "prompts":
          return (await this.getPrompts()).map(
            (p) => new PromptItem(p.name, p.filePath),
          );
        case "workflows":
          return (await this.getWorkflows()).map(
            (w) => new WorkflowItem(w.name, w.filePath),
          );
      }
    }
    if (element) {
      return [];
    }

    const [instructions, rules, skills, prompts, workflows] = await Promise.all([
      this.getInstructions(),
      this.getRules(),
      this.getSkills(),
      this.getPrompts(),
      this.getWorkflows(),
    ]);

    return [
      new SectionItem(
        "instructions",
        "Instructions",
        "book",
        instructions.length,
      ),
      new SectionItem("rules", "Rules", "symbol-ruler", rules.length),
      new SectionItem("skills", "Skills", "sparkle", skills.length),
      new SectionItem(
        "prompts",
        "Prompts",
        "comment-discussion",
        prompts.length,
      ),
      new SectionItem(
        "workflows",
        "Workflows & Actions",
        "play-circle",
        workflows.length,
      ),
    ];
  }
}

// ── Hooks Explorer ────────────────────────────────────────────────────────────

export class HookItem extends vscode.TreeItem {
  constructor(
    public readonly hookName: string,
    public readonly filePath: string,
    public readonly event: string,
    public readonly commandIndex: number,
    public readonly enabled: boolean,
  ) {
    super(hookName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = enabled ? "hook-enabled" : "hook-disabled";
    this.iconPath = enabled
      ? new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon(
          "zap-disabled",
          new vscode.ThemeColor("descriptionForeground"),
        );
    this.description = enabled ? "enabled" : "disabled";
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Edit Hook",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class HooksProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly getHooks: () => Promise<
      {
        name: string;
        filePath: string;
        event: string;
        commandIndex: number;
        enabled: boolean;
      }[]
    >,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return []; // HookItems are leaf nodes
    }
    try {
      const hooks = await this.getHooks();
      if (hooks.length === 0) {
        const empty = new vscode.TreeItem("No hooks configured");
        empty.description = 'Use "+" or add a .github/hooks/*.json file';
        empty.iconPath = new vscode.ThemeIcon("info");
        return [empty];
      }
      return hooks.map(
        (h) =>
          new HookItem(h.name, h.filePath, h.event, h.commandIndex, h.enabled),
      );
    } catch {
      return [];
    }
  }
}

// ── MCP Servers Explorer ─────────────────────────────────────────────────────

export class MCPSourceItem extends vscode.TreeItem {
  constructor(
    public readonly source: "workspace" | "user",
    public readonly servers: MCPServerItem[],
  ) {
    super(
      source === "workspace" ? "Workspace" : "User",
      servers.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "mcpSource";
    this.iconPath = new vscode.ThemeIcon(
      source === "workspace" ? "folder-library" : "account",
      new vscode.ThemeColor(
        source === "workspace" ? "charts.blue" : "charts.purple",
      ),
    );
    this.description = servers.length > 0 ? `${servers.length}` : "none";
    if (source === "workspace") {
      this.command = {
        command: "copilot-specs.openWorkspaceMcpConfig",
        title: "Open Workspace MCP Config",
      };
      this.tooltip = "Open or create .github/mcp.json";
    }
  }
}

export class MCPServerItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly source: "workspace" | "user",
    public readonly enabled: boolean,
    public readonly filePath: string,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = enabled ? "mcpServer-enabled" : "mcpServer-disabled";
    this.iconPath = enabled
      ? new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon(
          "debug-disconnect",
          new vscode.ThemeColor("descriptionForeground"),
        );
    this.description = enabled ? "enabled" : "disabled";
    this.tooltip = `${source} • ${filePath}`;
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: "vscode.open",
      title: "Open MCP Config",
      arguments: [vscode.Uri.file(filePath)],
    };
  }
}

export class MCPServersProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly getServers: () => Promise<
      {
        name: string;
        source: "workspace" | "user";
        enabled: boolean;
        filePath: string;
      }[]
    >,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof MCPSourceItem) {
      return element.servers;
    }
    if (element) {
      return [];
    }

    const servers = await this.getServers();
    if (servers.length === 0) {
      const empty = new vscode.TreeItem("No MCP servers found");
      empty.description =
        "Check .vscode/mcp.json, .mcp.json, mcp.json, or user mcp.json";
      empty.iconPath = new vscode.ThemeIcon("info");
      return [empty];
    }

    const workspaceServers = servers
      .filter((s) => s.source === "workspace")
      .map((s) => new MCPServerItem(s.name, s.source, s.enabled, s.filePath));

    const userServers = servers
      .filter((s) => s.source === "user")
      .map((s) => new MCPServerItem(s.name, s.source, s.enabled, s.filePath));

    return [
      new MCPSourceItem("workspace", workspaceServers),
      new MCPSourceItem("user", userServers),
    ];
  }
}
