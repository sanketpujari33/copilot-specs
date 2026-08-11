import * as path from "node:path";
import {
  readTextFile,
  requirementsUri,
  designUri,
  tasksUri,
  linksUri,
  fileExists,
} from "../utils/fileSystem.js";
import { loadTasks } from "../taskManager.js";
import { loadSpec } from "../specManager.js";

type SpecLinks = Record<string, string[]>;

/** Maximum number of lines to include from the design doc as an excerpt. */
const DESIGN_EXCERPT_LINES = 60;

/**
 * Extracts the full text of a `### REQ-xx` or `### FR-xx` section from a
 * requirements document. Returns all matching sections concatenated.
 */
function extractRequirementSections(
  content: string,
  requirementIds: string[],
): string {
  if (requirementIds.length === 0) {
    return "";
  }

  const lines = content.split("\n");
  const sections: string[] = [];

  for (const reqId of requirementIds) {
    // Match heading lines that contain this ID (case-insensitive)
    const idPattern = new RegExp(
      `###\\s+.*\\b${reqId.replace(/[-]/g, "[-]?")}\\b`,
      "i",
    );

    let inSection = false;
    let sectionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (idPattern.test(line)) {
        inSection = true;
        sectionLines = [line];
        continue;
      }
      if (inSection) {
        // Stop at the next heading of equal or higher level
        if (/^#{1,3}\s/.test(line)) {
          break;
        }
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      sections.push(sectionLines.join("\n").trim());
    }
  }

  return sections.join("\n\n");
}

/**
 * Returns the first DESIGN_EXCERPT_LINES non-empty lines of the design doc,
 * stopping at the first `## Key Modules` or `## Error Handling` section so
 * the excerpt stays focused on architecture and core flows.
 */
function extractDesignExcerpt(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let count = 0;

  for (const line of lines) {
    if (
      /^##\s+(Key Modules|Error Handling|Constraints|Open Questions|Decisions)/.test(
        line,
      )
    ) {
      break;
    }
    result.push(line);
    if (line.trim()) {
      count++;
    }
    if (count >= DESIGN_EXCERPT_LINES) {
      break;
    }
  }

  return result.join("\n").trim();
}

/**
 * Builds a rich Copilot Chat prompt for starting a specific task.
 * Includes: task metadata, linked requirement text, design doc excerpt,
 * and linked implementation file paths.
 */
export async function buildStartTaskPrompt(
  specName: string,
  taskId: string,
  subTaskLineIndex?: number,
): Promise<string> {
  const { tasks } = await loadTasks(specName);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return `Implement task ${taskId} in the "${specName}" spec.`;
  }

  const parts: string[] = [];

  // --- Header ---
  let fileLines: string[] = [];
  const tasksFileUri = tasksUri(specName);
  if (tasksFileUri && (await fileExists(tasksFileUri))) {
    const raw = await readTextFile(tasksFileUri);
    fileLines = raw.split("\n");
  }

  // Helper to extract lines following a specific line index up to the next task/subtask/heading
  const extractBody = (startIndex: number): string => {
    if (startIndex < 0 || startIndex >= fileLines.length) return "";
    const bodyLines: string[] = [];
    const TASK_MARKER = /^(\s*)-\s+\[(x|X|\*|-|~| )\]/;
    const HEADING_MARKER = /^###/;
    for (let i = startIndex + 1; i < fileLines.length; i++) {
      const line = fileLines[i];
      if (TASK_MARKER.test(line) || HEADING_MARKER.test(line)) {
        break;
      }
      bodyLines.push(line);
    }
    return bodyLines.join("\n").trim();
  };

  if (subTaskLineIndex !== undefined) {
    const subTask = task.subTasks.find(s => s.lineIndex === subTaskLineIndex);
    if (subTask) {
      parts.push(
        `You are helping implement a specific sub-task from the **${specName}** spec.`,
        ``,
        `## Sub-task: ${subTask.title}`,
      );
      const subBody = extractBody(subTask.lineIndex);
      if (subBody) {
        parts.push(``, subBody);
      }
      parts.push(``, `Part of Task: ${task.id} — ${task.title}`);
    }
  }

  // Fallback to parent task header if no subtask is matched or provided
  if (parts.length === 0) {
    parts.push(
      `You are helping implement a specific task from the **${specName}** spec.`,
      ``,
      `## Task: ${task.id} — ${task.title}`,
    );

    const taskBody = extractBody(task.lineIndex);
    if (taskBody) {
      parts.push(``, taskBody);
    }

    if (task.subTasks.length > 0) {
      parts.push(``, `### Sub-tasks`);
      for (const sub of task.subTasks) {
        const check = sub.completed ? "[x]" : "[ ]";
        parts.push(`- ${check} ${sub.title}`);
      }
    }
  }

  // --- Linked requirements ---
  const reqIds = task.requirementIds ?? [];
  if (reqIds.length > 0) {
    parts.push(``, `### Linked Requirements`, `IDs: ${reqIds.join(", ")}`);

    const reqFileUri = requirementsUri(specName);
    if (reqFileUri && (await fileExists(reqFileUri))) {
      const reqContent = await readTextFile(reqFileUri);
      const sections = extractRequirementSections(reqContent, reqIds);
      if (sections) {
        parts.push(``, sections);
      }
    }
  }

  // --- Design doc excerpt ---
  const designFileUri = designUri(specName);
  if (designFileUri && (await fileExists(designFileUri))) {
    const designContent = await readTextFile(designFileUri);
    const excerpt = extractDesignExcerpt(designContent);
    if (excerpt) {
      parts.push(``, `### Design Context`, ``, excerpt);
    }
  }

  // --- Linked implementation files ---
  const linksFileUri = linksUri(specName);
  let linkedFiles: string[] = [];
  if (linksFileUri && (await fileExists(linksFileUri))) {
    try {
      const raw = await readTextFile(linksFileUri);
      const parsed = JSON.parse(raw) as SpecLinks;
      linkedFiles = parsed[taskId] ?? [];
    } catch {
      // ignore malformed links file
    }
  }

  if (linkedFiles.length > 0) {
    parts.push(
      ``,
      `### Linked Implementation Files`,
      linkedFiles.map((f) => `- ${path.normalize(f)}`).join("\n"),
    );
  }

  // --- Instructions ---
  parts.push(
    ``,
    `---`,
    `## Implementation Instructions`,
    ``,
    `Please implement the **incomplete** sub-tasks listed above.`,
    ``,
    `1. **Read** the linked implementation files (and any other relevant project files) to understand the existing code before making changes.`,
    `2. **Implement** the required changes following existing project conventions and patterns.`,
    `3. **Verify** your changes compile and pass any existing tests.`,
    `4. Focus only on what this specific task requires — do not refactor unrelated code.`,
  );

  return parts.join("\n");
}

export async function buildRunAllTasksVerificationPrompt(
  specName: string,
  onlyRequired = false,
): Promise<string> {
  const spec = await loadSpec(specName);
  let { tasks } = await loadTasks(specName);
  if (onlyRequired) {
    tasks = tasks.filter((t) => !t.optional);
  }

  const pending = tasks.filter((t) => !t.completed);
  const completed = tasks.filter((t) => t.completed);

  const reqFileUri = requirementsUri(specName);
  const designFileUri = designUri(specName);
  const tasksFileUri = tasksUri(specName);

  const parts: string[] = [];
  parts.push(
    `You are verifying ${onlyRequired ? "**required** " : ""}implementation progress for the **${specName}** spec.`,
    "",
    `## Verification Goal`,
    `Validate ${onlyRequired ? "required " : "every "}task and sub-task against the current codebase, then update task status to match reality.`,
    "",
    `## Spec Context`,
    `- Spec name: ${specName}`,
    `- File scope: ${spec?.fileGlob ?? "**/*"}`,
    `- Requirements file: ${reqFileUri?.fsPath ?? "(not found)"}`,
    `- Design file: ${designFileUri?.fsPath ?? "(not found)"}`,
    `- Tasks file: ${tasksFileUri?.fsPath ?? "(not found)"}`,
    "",
    `## Task Summary (${onlyRequired ? "Required Tasks" : "All Tasks"})`,
    `- Total: ${tasks.length}`,
    `- Completed currently: ${completed.length}`,
    `- Pending currently: ${pending.length}`,
  );

  if (tasks.length > 0) {
    parts.push("", "### Tasks");
    for (const task of tasks) {
      const check = task.completed ? "[x]" : "[ ]";
      const requirements =
        task.requirementIds && task.requirementIds.length > 0
          ? ` (requires: ${task.requirementIds.join(", ")})`
          : "";
      parts.push(`- ${check} ${task.id}: ${task.title}${requirements}`);
      for (const sub of task.subTasks) {
        parts.push(`  - ${sub.completed ? "[x]" : "[ ]"} ${sub.title}`);
      }
    }
  }

  parts.push(
    "",
    "---",
    "## Instructions",
    "1. Read requirements, design, tasks docs, and relevant implementation files in scope.",
    "2. Verify each task/sub-task with concrete code evidence.",
    "3. Run appropriate build/tests for verification.",
    "4. Update `tasks.instructions.md` checkboxes so task state reflects actual completion.",
    "5. Return a concise verification report with: completed, still-pending, and any blockers.",
    "",
    "Do not perform unrelated refactors.",
  );

  return parts.join("\n");
}
