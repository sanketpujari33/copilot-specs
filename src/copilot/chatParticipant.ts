import * as vscode from "vscode";
import { generateFullSpec, generateSpecContent } from "./specGenerator.js";
import { loadSpec } from "../specManager.js";
import { preserveCompletedTaskStates } from "../taskManager.js";
import {
  readTextFile,
  fileExists,
  requirementsUri,
  designUri,
  tasksUri,
} from "../utils/fileSystem.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { buildStartTaskPrompt } from "./taskStarter.js";

interface ParsedCommand {
  action: "create" | "regenerate" | "implement" | "help";
  specName?: string;
  fileGlob?: string;
  section?: "requirements" | "design" | "tasks";
  taskId?: string;
}

function parseCommand(prompt: string, command?: string): ParsedCommand {
  let text = prompt.trim();
  if (command) {
    text = `/${command} ${text}`.trim();
  }

  // Strip leading slash if typed (e.g. /create -> create)
  text = text.replace(/^\//, "");

  // 1. Explicit 'for': @spec create <name> for <glob>
  const createForMatch = text.match(
    /^create\s+["']?(.+?)["']?\s+for\s+([^\s]+)\s*$/i,
  );
  if (createForMatch) {
    let specName = createForMatch[1].trim();
    specName = specName.replace(/^(a|an)\s+/i, "");
    return {
      action: "create",
      specName,
      fileGlob: createForMatch[2].trim(),
    };
  }

  // 2. Simple create: @spec create <name>
  const createSimple = text.match(/^create\s+["']?(.+?)["']?\s*$/i);
  if (createSimple) {
    let specName = createSimple[1].trim();
    specName = specName.replace(/^(a|an)\s+/i, "");
    return { action: "create", specName };
  }

  // @spec regenerate <spec> requirements|design|tasks
  const regenMatch = text.match(
    /^regenerate\s+(\S+)\s+(requirements|design|tasks)\s*$/i,
  );
  if (regenMatch) {
    return {
      action: "regenerate",
      specName: regenMatch[1].trim(),
      section: regenMatch[2].toLowerCase() as
        | "requirements"
        | "design"
        | "tasks",
    };
  }

  // @spec implement <spec> <taskId>
  const implementMatch = text.match(/^implement\s+(\S+)\s+(\S+)\s*$/i);
  if (implementMatch) {
    return {
      action: "implement",
      specName: implementMatch[1].trim(),
      taskId: implementMatch[2].trim(),
    };
  }

  return { action: "help" };
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  _onTaskStart?: (specName: string, taskId: string) => void,
  _onTaskComplete?: (specName: string, taskId: string) => void,
): void {
  const participant = vscode.chat.createChatParticipant(
    "copilot-specs.spec",
    async (request, _chatContext, stream, _token) => {
      const parsed = parseCommand(request.prompt, request.command);

      if (parsed.action === "help") {
        stream.markdown(
          `## Copilot Specs\n\n` +
            `I help you create and manage feature specs with requirements, design docs, and task lists.\n\n` +
            `**Slash Commands:**\n\n` +
            `- \`@spec /create <name> for <glob>\` — Create a new spec with AI-generated content\n` +
            `  *Example: \`@spec /create auth for src/auth/**\`*\n\n` +
            `- \`@spec /create <name>\` — Create a spec (auto-assigns default file glob)\n\n` +
            `- \`@spec /regenerate <spec-name> requirements|design|tasks\` — Regenerate a specific section\n\n` +
            `- \`@spec /implement <spec-name> <task-id>\` — Get task implementation prompt\n`,
        );
        return;
      }

      if (parsed.action === "implement" && parsed.specName && parsed.taskId) {
        const { specName, taskId } = parsed;
        // Build and display the task context so the user can copy it to
        // agent mode where the agent has full tool access (file reads,
        // edits, terminal, etc.).  The @spec participant does NOT have
        // tool access, so we no longer attempt a blind LLM call here.
        const contextPrompt = await buildStartTaskPrompt(specName, taskId);
        stream.markdown(contextPrompt);
        stream.markdown(
          `\n\n---\n> **Tip:** For best results, use the **Start Task** CodeLens button ` +
            `which opens this prompt in agent mode where Copilot has full tool access ` +
            `to read files, make edits, and run tests.\n`,
        );
        return;
      }

      if (parsed.action === "create") {
        const fileGlob =
          parsed.fileGlob ??
          `src/${parsed.specName!.toLowerCase().replace(/\s+/g, "-")}/**`;

        if (!parsed.fileGlob) {
          stream.markdown(`Creating spec **${parsed.specName}**...\n\n`);
          stream.markdown(
            `Using file glob: \`${fileGlob}\` (you can change this in the generated files)\n\n`,
          );
        }

        await generateFullSpec(
          parsed.specName!,
          fileGlob,
          stream,
          request.model,
        );
        return;
      }

      if (parsed.action === "regenerate" && parsed.specName && parsed.section) {
        const spec = await loadSpec(parsed.specName);
        if (!spec) {
          stream.markdown(
            `> Spec **${parsed.specName}** not found. Use \`@spec create ${parsed.specName}\` to create it.\n`,
          );
          return;
        }

        stream.markdown(
          `## Regenerating **${parsed.section}** for spec: ${parsed.specName}\n\n`,
        );

        // Load existing context from other sections
        let existingContext = "";
        try {
          const rUri = requirementsUri(parsed.specName);
          const dUri = designUri(parsed.specName);
          if (rUri && (await fileExists(rUri))) {
            existingContext += `Requirements:\n${stripFrontmatter(await readTextFile(rUri))}\n\n`;
          }
          if (dUri && (await fileExists(dUri))) {
            existingContext += `Design:\n${stripFrontmatter(await readTextFile(dUri))}\n\n`;
          }
        } catch {
          // Use empty context
        }

        const newContent = await generateSpecContent(
          parsed.specName,
          spec.fileGlob,
          existingContext,
          parsed.section,
          stream,
          request.model,
        );

        if (newContent) {
          const { writeTextFile } = await import("../utils/fileSystem.js");
          const { serializeFrontmatter } =
            await import("../utils/frontmatter.js");

          let uri: vscode.Uri | undefined;
          let fm: Record<string, string> = {};

          if (parsed.section === "requirements") {
            uri = requirementsUri(parsed.specName);
            fm = {
              name: `${parsed.specName} Requirements`,
              applyTo: spec.fileGlob,
            };
          } else if (parsed.section === "design") {
            uri = designUri(parsed.specName);
            fm = { name: `${parsed.specName} Design`, applyTo: spec.fileGlob };
          } else {
            uri = tasksUri(parsed.specName);
          }

          if (uri) {
            let fileContent: string;
            if (parsed.section === "tasks") {
              // Preserve already-completed tasks so regeneration doesn't reset them
              fileContent = await preserveCompletedTaskStates(
                parsed.specName,
                newContent,
              );
            } else {
              fileContent = serializeFrontmatter(fm, newContent);
            }
            await writeTextFile(uri, fileContent);
            stream.markdown(`\n\n✅ ${parsed.section} file updated.\n`);
            const reqOpenUri = requirementsUri(parsed.specName);
            if (reqOpenUri) {
              stream.button({
                command: "vscode.open",
                arguments: [reqOpenUri],
                title: "Open Requirements",
              });
            }
          }
        }

        return;
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon("tasklist");
  context.subscriptions.push(participant);
}
