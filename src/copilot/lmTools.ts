import * as vscode from "vscode";
import { listSpecs, loadSpec } from "../specManager.js";
import { loadTasks, markTaskAndSubtasksCompleted, calculateProgress } from "../taskManager.js";
import { buildStartTaskPrompt } from "./taskStarter.js";
import {
  readTextFile,
  requirementsUri,
  designUri,
  fileExists,
} from "../utils/fileSystem.js";
import { stripFrontmatter } from "../utils/frontmatter.js";

/**
 * LM Tool: copilotSpecs_listSpecs
 */
export class ListSpecsTool implements vscode.LanguageModelTool<{}> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<{}>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const specs = await listSpecs();
    const resultList = [];

    for (const spec of specs) {
      const { tasks } = await loadTasks(spec.name);
      const progress = calculateProgress(tasks);
      resultList.push({
        name: spec.name,
        fileGlob: spec.fileGlob,
        progress: {
          total: progress.total,
          completed: progress.completed,
          percentage: progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
        },
      });
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({ specs: resultList }, null, 2)),
    ]);
  }
}

/**
 * LM Tool: copilotSpecs_getSpecDetails
 */
export class GetSpecDetailsTool
  implements vscode.LanguageModelTool<{ specName: string }>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ specName: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { specName } = options.input;
    const spec = await loadSpec(specName);
    if (!spec) {
      throw new Error(`Spec "${specName}" not found.`);
    }

    let requirements = "";
    let design = "";
    const reqUri = requirementsUri(specName);
    const dUri = designUri(specName);

    if (reqUri && (await fileExists(reqUri))) {
      requirements = stripFrontmatter(await readTextFile(reqUri));
    }
    if (dUri && (await fileExists(dUri))) {
      design = stripFrontmatter(await readTextFile(dUri));
    }

    const { tasks } = await loadTasks(specName);

    const result = {
      name: spec.name,
      fileGlob: spec.fileGlob,
      requirements,
      design,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        completed: t.completed,
        requirementIds: t.requirementIds,
        subTasks: t.subTasks.map((s) => ({
          title: s.title,
          completed: s.completed,
        })),
      })),
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
    ]);
  }
}

/**
 * LM Tool: copilotSpecs_getTaskContext
 */
export class GetTaskContextTool
  implements vscode.LanguageModelTool<{ specName: string; taskId: string }>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ specName: string; taskId: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { specName, taskId } = options.input;
    const prompt = await buildStartTaskPrompt(specName, taskId);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(prompt),
    ]);
  }
}

/**
 * LM Tool: copilotSpecs_markTaskComplete
 */
export class MarkTaskCompleteTool
  implements vscode.LanguageModelTool<{ specName: string; taskId: string }>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ specName: string; taskId: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { specName, taskId } = options.input;
    await markTaskAndSubtasksCompleted(specName, taskId, true);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Successfully marked task ${taskId} and its sub-tasks as completed in spec "${specName}".`,
      ),
    ]);
  }
}

/**
 * Register all Copilot Specs language model tools
 */
export function registerSpecLMTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool("copilotSpecs_listSpecs", new ListSpecsTool()),
    vscode.lm.registerTool("copilotSpecs_getSpecDetails", new GetSpecDetailsTool()),
    vscode.lm.registerTool("copilotSpecs_getTaskContext", new GetTaskContextTool()),
    vscode.lm.registerTool("copilotSpecs_markTaskComplete", new MarkTaskCompleteTool()),
  );

  console.log("Copilot Specs: Spec language model tools registered for all agents.");
}
