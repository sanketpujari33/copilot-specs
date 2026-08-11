/**
 * Template definition from .todo.json
 */
export interface TodoTemplate {
  id: string;
  name: string;
  description: string;
  applyTo?: string; // Glob pattern (optional - if not set, creates a branch-level todo)
  fileContains?: string; // Content that must be present
  excludeFileContains?: string; // Content that must NOT be present
  priority?: 'high' | 'medium' | 'low';
  branchLevel?: boolean; // If true, this todo appears once per branch (no file association)
  aiInstruction?: string; // Instructions for AI agents on how to complete this task
}

/**
 * Configuration file structure
 */
export interface TodoConfig {
  templates: TodoTemplate[];
}

/**
 * Active todo instance for a specific file and branch
 */
export interface TodoInstance {
  id: string; // Format: templateId:relativePath (or just templateId for branch-level todos)
  templateId: string;
  name: string;
  description: string;
  filePath?: string; // Absolute path (undefined for branch-level todos)
  relativePath?: string; // Workspace-relative path (undefined for branch-level todos)
  priority: 'high' | 'medium' | 'low';
  completed: boolean;
  completedAt?: string;
  ignored: boolean;
  ignoredAt?: string;
  branch: string;
  branchLevel?: boolean; // True if this is a branch-level todo (not tied to a file)
  triggeringFiles?: string[]; // Files that triggered this branch-level todo (relative paths)
  aiInstruction?: string; // Instructions for AI agents on how to complete this task
  isManual?: boolean; // True if this todo was created manually by an AI agent or user (not from template matching)
}

/**
 * Persisted state for todos (stored in workspace state)
 */
export interface TodoState {
  [branchName: string]: {
    todos: {
      [todoId: string]: {
        completed: boolean;
        completedAt?: string;
        ignored: boolean;
        ignoredAt?: string;
        filePath?: string; // Optional for branch-level todos
        templateId: string;
        branchLevel?: boolean; // True if this is a branch-level todo
        triggeringFiles?: string[]; // Files that triggered this branch-level todo
        isManual?: boolean; // True if created manually by an AI agent
        name?: string; // Stored for manual todos (not backed by a template)
        description?: string; // Stored for manual todos
        priority?: 'high' | 'medium' | 'low'; // Stored for manual todos
      };
    };
  };
}

/**
 * Tree item types for the tree view
 */
export type TodoTreeItemType = 'group' | 'todoItem';

/**
 * Priority group for tree view
 */
export interface PriorityGroup {
  priority: 'high' | 'medium' | 'low';
  label: string;
  icon: string;
  todos: TodoInstance[];
}
