import * as vscode from "vscode";
import { Task, SubTask, TaskProgress } from "./models/index.js";
import {
  readTextFile,
  writeTextFile,
  fileExists,
  tasksUri,
  resolveWorkspacePath,
  INSTRUCTIONS_SPECS_DIR,
  listDirectories,
} from "./utils/fileSystem.js";

// Regex patterns for task parsing — match any markdown checkbox line (including [x]*)
const TASK_LINE = /^(\s*)-\s+\[(x\*?|X\*?| )\]\s+(.+)$/;
const SUBTASK_LINE = /^(\s{2,})-\s+\[(x\*?|X\*?| )\]\s+(.+)$/;
const NUMBERED_SUBTASK_LINE = /^(\s*)-\s+\[(x\*?|X\*?| )\]\s+(\d+\.\d+)\s+(.+)$/;
// Heading-style tasks: ### T1: Title, ### - [ ] T1: Title, or ### - [x] T1: Title
const HEADING_TASK_LINE = /^###\s+(?:-\s+\[(x\*?|X\*?| )\]\s+)?(.+)$/;
const PHASE_HEADER = /^###\s+(Phase\s+[^\n<!--]+)/i;
const FILES_COMMENT = /<!--\s*files:\s*(.+?)\s*-->/;
const TASK_ID_COMMENT = /<!--\s*task:\s*(\S+)\s*-->/;
const REQUIRES_COMMENT = /<!--\s*requires?:\s*(.+?)\s*-->/;
const BOLD_ID = /^\*\*(\S+?)\*\*[:\s]\s*/;

function normalizeRequirementId(value: string): string {
  return value
    .trim()
    .replace(/^[-*\s:]+|[-*\s:]+$/g, "")
    .toUpperCase();
}

export function extractRequirementIdsFromText(text: string): string[] {
  const matches = text.match(/\b([A-Z]+-\d+(?:\.\d+)*|R\d+)\b/gi) ?? [];
  return [...new Set(matches.map((m) => normalizeRequirementId(m)))];
}

export interface TasksParseResult {
  tasks: Task[];
  fileGlob: string | undefined;
}

export function parseTasks(
  content: string,
  specName: string,
): TasksParseResult {
  const lines = content.split("\n");
  const tasks: Task[] = [];
  let currentTask: Task | undefined;
  let currentHeadingTask: Task | undefined;
  let currentPhase: string | undefined;
  let taskCounter = 0;
  let fileGlob: string | undefined;
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, ""); // normalise Windows CRLF

    // Skip YAML frontmatter block
    if (!frontmatterDone) {
      if (i === 0 && line.trim() === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (line.trim() === "---") {
          inFrontmatter = false;
          frontmatterDone = true;
        }
        continue;
      }
      frontmatterDone = true; // no frontmatter present
    }

    // Extract files comment
    const filesMatch = line.match(FILES_COMMENT);
    if (filesMatch) {
      fileGlob = filesMatch[1].trim();
      continue;
    }

    // Check phase header (e.g., ### Phase 1: Foundation)
    const phaseMatch = line.match(PHASE_HEADER);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim().replace(/\s*<!--.*-->/, "").trim();
    }

    // Numbered subtask pattern (- [ ] 1.1 title or - [ ] 2.3 title)
    const numSubMatch = line.match(NUMBERED_SUBTASK_LINE);
    if (numSubMatch && currentTask && !line.trim().startsWith("###")) {
      const checkVal = numSubMatch[2].toLowerCase();
      const sub: SubTask = {
        title: `${numSubMatch[3]} ${numSubMatch[4].trim()}`,
        completed: checkVal.startsWith("x"),
        autoVerified: checkVal.includes("*"),
        lineIndex: i,
      };
      currentTask.subTasks.push(sub);
      continue;
    }

    const subtaskMatch = line.match(SUBTASK_LINE);
    if (subtaskMatch && currentTask) {
      const checkVal = subtaskMatch[2].toLowerCase();
      const sub: SubTask = {
        title: subtaskMatch[3].trim(),
        completed: checkVal.startsWith("x"),
        autoVerified: checkVal.includes("*"),
        lineIndex: i,
      };
      currentTask.subTasks.push(sub);
      continue;
    }

    // Heading-style parent task: ### T1: Title  /or/  ### - [ ] T1: Title
    const headingTaskMatch = line.match(HEADING_TASK_LINE);
    if (headingTaskMatch && !line.match(/^###\s+Phase/i)) {
      taskCounter++;
      const explicitCheckbox = headingTaskMatch[1];
      let titlePart = headingTaskMatch[2].trim();

      let id: string | undefined;
      const commentId = titlePart.match(TASK_ID_COMMENT);
      if (commentId) {
        id = commentId[1];
        titlePart = titlePart.replace(TASK_ID_COMMENT, "").trim();
      }
      const boldId = titlePart.match(BOLD_ID);
      if (!id && boldId) {
        id = boldId[1];
        titlePart = titlePart.replace(BOLD_ID, "").trim();
      }
      if (!id) {
        const colonId = titlePart.match(/^(\S+?):\s+/);
        if (colonId) {
          id = colonId[1];
          titlePart = titlePart.replace(/^\S+?:\s+/, "").trim();
        }
      }
      if (!id) {
        id = `T${taskCounter}`;
      }

      let requirementIds: string[] | undefined;
      const requiresMatch = titlePart.match(REQUIRES_COMMENT);
      if (requiresMatch) {
        const reqStr = requiresMatch[1].trim();
        requirementIds = reqStr
          .split(",")
          .map((r) => normalizeRequirementId(r))
          .filter((r) => r.length > 0);
        titlePart = titlePart.replace(REQUIRES_COMMENT, "").trim();
      }
      if (!requirementIds || requirementIds.length === 0) {
        const inferred = extractRequirementIdsFromText(titlePart);
        if (inferred.length > 0) {
          requirementIds = inferred;
        }
      }

      const explicitCheckVal = explicitCheckbox?.toLowerCase() ?? "";
      currentTask = {
        id,
        title: titlePart,
        completed: explicitCheckVal.startsWith("x"),
        autoVerified: explicitCheckVal.includes("*"),
        specName,
        lineIndex: i,
        subTasks: [],
        requirementIds,
        phase: currentPhase,
      };
      tasks.push(currentTask);
      currentHeadingTask = currentTask;
      continue;
    }

    const taskMatch = line.match(TASK_LINE);
    if (taskMatch) {
      if (currentHeadingTask) {
        const checkVal = taskMatch[2].toLowerCase();
        const sub: SubTask = {
          title: taskMatch[3].trim(),
          completed: checkVal.startsWith("x"),
          autoVerified: checkVal.includes("*"),
          lineIndex: i,
        };
        currentHeadingTask.subTasks.push(sub);
        continue;
      }

      taskCounter++;
      let titlePart = taskMatch[3].trim();

      let id: string | undefined;
      const commentId = titlePart.match(TASK_ID_COMMENT);
      if (commentId) {
        id = commentId[1];
        titlePart = titlePart.replace(TASK_ID_COMMENT, "").trim();
      }
      const boldId = titlePart.match(BOLD_ID);
      if (!id && boldId) {
        id = boldId[1];
        titlePart = titlePart.replace(BOLD_ID, "").trim();
      }
      if (!id) {
        id = `T${taskCounter}`;
      }

      let requirementIds: string[] | undefined;
      const requiresMatch = titlePart.match(REQUIRES_COMMENT);
      if (requiresMatch) {
        const reqStr = requiresMatch[1].trim();
        requirementIds = reqStr
          .split(",")
          .map((r) => normalizeRequirementId(r))
          .filter((r) => r.length > 0);
        titlePart = titlePart.replace(REQUIRES_COMMENT, "").trim();
      }

      if (!requirementIds || requirementIds.length === 0) {
        const inferred = extractRequirementIdsFromText(titlePart);
        if (inferred.length > 0) {
          requirementIds = inferred;
        }
      }

      const checkVal = taskMatch[2].toLowerCase();
      currentTask = {
        id,
        title: titlePart,
        completed: checkVal.startsWith("x"),
        autoVerified: checkVal.includes("*"),
        specName,
        lineIndex: i,
        subTasks: [],
        requirementIds,
        phase: currentPhase,
      };
      tasks.push(currentTask);
    } else if (
      line.trim() &&
      !line.trim().startsWith("#") &&
      !line.trim().startsWith(">") &&
      !line.trim().startsWith("<!--")
    ) {
      if (!line.trim().startsWith("-") && !line.trim().startsWith("*")) {
        currentTask = undefined;
        currentHeadingTask = undefined;
      }
    }
  }

  // For heading-style tasks without explicit checkbox, derive completed state from subtasks
  const HEADING_EXPLICIT_CHECKBOX = /^###\s+-\s+\[(x\*?|X\*?| )\]/;
  for (const task of tasks) {
    const taskLine = lines[task.lineIndex]?.trimStart() ?? "";
    if (
      taskLine.startsWith("###") &&
      !HEADING_EXPLICIT_CHECKBOX.test(taskLine) &&
      task.subTasks.length > 0
    ) {
      task.completed = task.subTasks.every((st) => st.completed);
    }
  }

  return { tasks, fileGlob };
}

export function calculateProgress(tasks: Task[]): TaskProgress {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;

  const phaseMap = new Map<string, { total: number; completed: number }>();
  for (const task of tasks) {
    if (task.phase) {
      const p = phaseMap.get(task.phase) ?? { total: 0, completed: 0 };
      p.total++;
      if (task.completed) {
        p.completed++;
      }
      phaseMap.set(task.phase, p);
    }
  }

  const phases = Array.from(phaseMap.entries()).map(([name, stat]) => ({
    name,
    total: stat.total,
    completed: stat.completed,
  }));

  return { total, completed, phases: phases.length > 0 ? phases : undefined };
}

export async function loadTasks(specName: string): Promise<TasksParseResult> {
  const uri = tasksUri(specName);
  if (!uri) {
    return { tasks: [], fileGlob: undefined };
  }

  if (!(await fileExists(uri))) {
    return { tasks: [], fileGlob: undefined };
  }

  const content = await readTextFile(uri);
  return parseTasks(content, specName);
}

export async function setTaskCompleted(
  specName: string,
  taskId: string,
  completed: boolean,
): Promise<void> {
  const uri = tasksUri(specName);
  if (!uri) {
    return;
  }

  const content = await readTextFile(uri);
  const lines = content.split("\n");

  const { tasks } = parseTasks(content, specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return;
  }

  const newMark = completed ? "x" : " ";
  lines[task.lineIndex] = lines[task.lineIndex].replace(
    /\[(x| )\]/,
    `[${newMark}]`,
  );

  await writeTextFile(uri, lines.join("\n"));
}

/**
 * Mark a task and ALL of its subtasks as complete (or incomplete).
 * For heading-style tasks (`### T1: Title`) the heading line is updated only
 * when it carries an explicit `- [x]` checkbox; otherwise only the subtask
 * lines are toggled. For regular checkbox tasks the parent line is always
 * toggled together with every subtask.
 */
export async function markTaskAndSubtasksCompleted(
  specName: string,
  taskId: string,
  completed: boolean,
): Promise<void> {
  const uri = tasksUri(specName);
  if (!uri) {
    return;
  }

  const content = await readTextFile(uri);
  const lines = content.split("\n");
  const { tasks } = parseTasks(content, specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return;
  }

  const newMark = completed ? "x" : " ";
  const HEADING_EXPLICIT = /^###\s+-\s+\[(x| )\]/;

  // Update the parent line — always for checkbox tasks; only when the heading
  // carries an explicit checkbox for heading-style tasks.
  const parentLine = lines[task.lineIndex] ?? "";
  const isHeading = parentLine.trimStart().startsWith("###");
  if (!isHeading || HEADING_EXPLICIT.test(parentLine.trimStart())) {
    lines[task.lineIndex] = parentLine.replace(/\[(x| )\]/, `[${newMark}]`);
  }

  // Update every subtask line.
  for (const sub of task.subTasks) {
    if (sub.lineIndex >= 0 && sub.lineIndex < lines.length) {
      lines[sub.lineIndex] = lines[sub.lineIndex].replace(
        /\[(x| )\]/,
        `[${newMark}]`,
      );
    }
  }

  await writeTextFile(uri, lines.join("\n"));
}

/**
 * Apply a pre-built set of completed task IDs to the given tasks file content.
 * Lines whose task ID is in `completedIds` will have their checkbox changed to `[x]`.
 */
export function applyCompletedIds(
  newContent: string,
  completedIds: Set<string>,
  specName: string,
): string {
  if (completedIds.size === 0) {
    return newContent;
  }

  const { tasks: newTasks } = parseTasks(newContent, specName);
  const lines = newContent.split("\n");

  for (const task of newTasks) {
    if (completedIds.has(task.id) && !task.completed) {
      lines[task.lineIndex] = lines[task.lineIndex].replace(/\[(x| )\]/, "[x]");
    }
  }

  return lines.join("\n");
}

/**
 * Given the content of a newly generated tasks file, apply the completion
 * state from the *existing* tasks file on disk so that already-completed
 * tasks are not reset.  Matching is done by task ID (T1, T2, …).
 */
export async function toggleTaskRequired(
  specName: string,
  taskId: string,
): Promise<void> {
  const { loadSpec } = await import("./specManager.js");
  const spec = await loadSpec(specName);
  if (!spec) {
    return;
  }

  const uri = vscode.Uri.file(spec.tasksPath);
  if (!(await fileExists(uri))) {
    return;
  }

  const content = await readTextFile(uri);
  const lines = content.split("\n");
  const { tasks } = parseTasks(content, specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.lineIndex < 0 || task.lineIndex >= lines.length) {
    return;
  }

  const line = lines[task.lineIndex];
  let newLine = line;
  if (line.includes("- [ ]*")) {
    newLine = line.replace("- [ ]*", "- [ ]");
  } else if (line.includes("- [ ]")) {
    newLine = line.replace("- [ ]", "- [ ]*");
  } else if (line.includes("- [x]*")) {
    newLine = line.replace("- [x]*", "- [x]");
  } else if (line.includes("- [x]")) {
    newLine = line.replace("- [x]", "- [x]*");
  }

  lines[task.lineIndex] = newLine;
  await writeTextFile(uri, lines.join("\n"));
}

export async function preserveCompletedTaskStates(
  specName: string,
  newContent: string,
): Promise<string> {
  const { tasks: existingTasks } = await loadTasks(specName);
  const completedIds = new Set(
    existingTasks.filter((t) => t.completed).map((t) => t.id),
  );

  return applyCompletedIds(newContent, completedIds, specName);
}

export async function getAllSpecNames(): Promise<string[]> {
  const root = resolveWorkspacePath(INSTRUCTIONS_SPECS_DIR);
  if (!root) {
    return [];
  }

  try {
    return await listDirectories(root);
  } catch {
    return [];
  }
}

export async function loadAllTasks(): Promise<Map<string, TasksParseResult>> {
  const specNames = await getAllSpecNames();
  const result = new Map<string, TasksParseResult>();

  for (const name of specNames) {
    result.set(name, await loadTasks(name));
  }

  return result;
}

export interface TaskValidationIssue {
  /** 0-based line index */
  line: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * Validates the markdown content of a spec tasks (or requirements) file and
 * returns a list of diagnostics. The caller is responsible for converting
 * these to VS Code Diagnostics.
 */
export function validateTaskMarkdown(content: string): TaskValidationIssue[] {
  const issues: TaskValidationIssue[] = [];
  const lines = content.split("\n");
  const seenIds = new Map<string, number>();
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");

    // Skip YAML frontmatter
    if (!frontmatterDone) {
      if (i === 0 && line.trim() === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (line.trim() === "---") {
          inFrontmatter = false;
          frontmatterDone = true;
        }
        continue;
      }
      frontmatterDone = true;
    }

    // Detect invalid checkbox markers, e.g. - [?] or - [y]
    const checkboxCandidate = line.match(/^(\s*)-\s+\[(.{1})\]/);
    if (checkboxCandidate) {
      const marker = checkboxCandidate[2];
      if (!/^(x|X| )$/.test(marker)) {
        issues.push({
          line: i,
          message: `Invalid checkbox marker "[${marker}]" — use "[ ]" or "[x]".`,
          severity: "error",
        });
      }
    }

    // Detect duplicate task IDs from <!-- task:ID --> comments
    const idMatch = line.match(TASK_ID_COMMENT);
    if (idMatch) {
      const id = idMatch[1];
      if (seenIds.has(id)) {
        issues.push({
          line: i,
          message: `Duplicate task ID "${id}" — first defined on line ${(seenIds.get(id) ?? 0) + 1}.`,
          severity: "error",
        });
      } else {
        seenIds.set(id, i);
      }
    }

    // Detect a requires-style HTML comment that has a space before the colon,
    // which prevents the parser from recognising it (e.g. <!-- requires : REQ-01 -->)
    const badRequires = line.match(/<!--\s*requires?\s+:\s*(.+?)\s*-->/);
    if (badRequires) {
      issues.push({
        line: i,
        message: `Malformed requires comment — remove the space before ":": use <!-- requires:${badRequires[1].trim()} -->.`,
        severity: "warning",
      });
    }

    // Detect unclosed HTML comments (<!-- without -->)
    const openCount = (line.match(/<!--/g) ?? []).length;
    const closeCount = (line.match(/-->/g) ?? []).length;
    if (openCount > closeCount) {
      issues.push({
        line: i,
        message: 'Unclosed HTML comment — missing "-->".',
        severity: "error",
      });
    }
  }

  return issues;
}
