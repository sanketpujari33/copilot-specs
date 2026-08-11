export type SpecType = "feature" | "bugfix" | "quick";
export type WorkflowType = "requirements-first" | "tech-design-first" | "quick";

export interface SpecConfig {
  specId: string;
  specType: SpecType;
  workflowType: WorkflowType;
  createdAt: string;
}

export interface Spec {
  name: string;
  fileGlob: string;
  requirementsPath: string;
  designPath: string;
  tasksPath: string;
  linksPath: string;
  specType: SpecType;
  workflowType: WorkflowType;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  specName: string;
  lineIndex: number;
  subTasks: SubTask[];
  requirementIds?: string[];
  phase?: string;
  inProgress?: boolean;
  queued?: boolean;
  optional?: boolean;
}

export interface SubTask {
  title: string;
  completed: boolean;
  lineIndex: number;
  inProgress?: boolean;
  queued?: boolean;
  optional?: boolean;
}

export interface PhaseProgress {
  name: string;
  total: number;
  completed: number;
}

export interface TaskProgress {
  total: number;
  completed: number;
  phases?: PhaseProgress[];
}

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

export const HOOK_EVENT_NAMES: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

export interface HookCommand {
  type: "command";
  command: string;
  enabled?: boolean;
  windows?: string;
  linux?: string;
  osx?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface HooksFileConfig {
  hooks: Partial<Record<HookEventName, HookCommand[]>>;
}

export interface Hook {
  name: string; // display label: "{event}: {short command}"
  filePath: string; // path to the .json file
  event: HookEventName;
  enabled: boolean;
  commandIndex: number;
  commandEntry: HookCommand;
}

export interface SteeringEntry {
  name: string;
  content: string;
}

export interface SpecLinks {
  [taskId: string]: string[];
}

export interface InstructionsFrontmatter {
  name?: string;
  applyTo?: string;
  description?: string;
}
