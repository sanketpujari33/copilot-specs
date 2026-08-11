import * as vscode from "vscode";
import { createSpec } from "../specManager.js";
import { readSteeringForContext, getPlanAgentsContext } from "../steeringManager.js";
import { loadTasks, applyCompletedIds } from "../taskManager.js";

export async function selectBestChatModel(): Promise<vscode.LanguageModelChat | undefined> {
  const config = vscode.workspace.getConfiguration("copilot-specs");
  const prefFamily = config.get<string>("preferredModelFamily", "").trim();
  const prefVendor = config.get<string>("preferredModelVendor", "").trim();

  // 1. Explicit User Preferred Model configuration (if configured)
  if (prefFamily || prefVendor) {
    try {
      const selector: vscode.LanguageModelChatSelector = {};
      if (prefFamily) {
        selector.family = prefFamily;
      }
      if (prefVendor) {
        selector.vendor = prefVendor;
      }
      const models = await vscode.lm.selectChatModels(selector);
      if (models && models.length > 0) {
        return models[0];
      }
    } catch (err) {
      console.warn("Error querying user-preferred model:", err);
    }
  }

  // 2. Automatic Mode: Auto-get active model selected in VS Code environment
  try {
    const models = await vscode.lm.selectChatModels({});
    if (models && models.length > 0) {
      for (const m of models) {
        if (m) {
          return m;
        }
      }
    }
  } catch (err) {
    console.warn("Error auto-getting active language chat models:", err);
  }

  // 3. Fallback Cascade through specific local & cloud model selectors
  const selectors: vscode.LanguageModelChatSelector[] = [
    { vendor: "lemonade" },
    { vendor: "ollama" },
    { vendor: "lmstudio" },
    { family: "local" },
    { family: "gpt-4o" },
    { family: "gpt-4" },
    { family: "claude-3.5-sonnet" },
    { family: "gemini-1.5-pro" },
  ];

  for (const selector of selectors) {
    try {
      const models = await vscode.lm.selectChatModels(selector);
      if (models && models.length > 0) {
        return models[0];
      }
    } catch {
      // Continue to next selector if error occurs
    }
  }

  return undefined;
}

export async function promptSelectModel(): Promise<void> {
  let allModels: vscode.LanguageModelChat[] = [];
  try {
    allModels = await vscode.lm.selectChatModels({});
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to list language models: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  interface ModelQuickPickItem extends vscode.QuickPickItem {
    family?: string;
    vendor?: string;
    isAuto?: boolean;
  }

  const items: ModelQuickPickItem[] = [
    {
      label: "$(sparkle) Automatic (Best Available)",
      description: "Auto-select best local or cloud model based on availability",
      isAuto: true,
    },
  ];

  for (const model of allModels) {
    const isLocal =
      model.vendor.toLowerCase().includes("lemonade") ||
      model.vendor.toLowerCase().includes("ollama") ||
      model.vendor.toLowerCase().includes("lmstudio") ||
      model.family.toLowerCase().includes("local");
    const icon = isLocal ? "$(server-environment)" : "$(cloud)";
    items.push({
      label: `${icon} ${model.name || model.id}`,
      description: `Vendor: ${model.vendor} | Family: ${model.family}`,
      detail: `ID: ${model.id} (Max input tokens: ${model.maxInputTokens})`,
      family: model.family,
      vendor: model.vendor,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select preferred Language Model for Copilot Specs",
  });

  if (!picked) {
    return;
  }

  const config = vscode.workspace.getConfiguration("copilot-specs");
  if (picked.isAuto) {
    await config.update(
      "preferredModelFamily",
      "",
      vscode.ConfigurationTarget.Global,
    );
    await config.update(
      "preferredModelVendor",
      "",
      vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage(
      "Language model reset to Automatic mode.",
    );
  } else {
    await config.update(
      "preferredModelFamily",
      picked.family || "",
      vscode.ConfigurationTarget.Global,
    );
    await config.update(
      "preferredModelVendor",
      picked.vendor || "",
      vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage(
      `Set preferred language model: ${picked.label}`,
    );
  }
}

export async function getAllCandidateModels(
  preferredModel?: vscode.LanguageModelChat,
): Promise<vscode.LanguageModelChat[]> {
  const config = vscode.workspace.getConfiguration("copilot-specs");
  const prefFamily = config.get<string>("preferredModelFamily", "").trim();
  const prefVendor = config.get<string>("preferredModelVendor", "").trim();

  const candidates: vscode.LanguageModelChat[] = [];

  // 0. Highest priority: User's explicitly selected model from Chat prompt dropdown (request.model)
  if (preferredModel) {
    candidates.push(preferredModel);
  }

  // If user configured explicit preference in extension settings, query exact match
  if (prefFamily || prefVendor) {
    try {
      const selector: vscode.LanguageModelChatSelector = {};
      if (prefFamily) {
        selector.family = prefFamily;
      }
      if (prefVendor) {
        selector.vendor = prefVendor;
      }
      const models = await vscode.lm.selectChatModels(selector);
      if (models && models.length > 0) {
        candidates.push(...models);
      }
    } catch {}
  }

  const primary = await selectBestChatModel();
  if (primary) {
    candidates.push(primary);
  }

  const selectors: vscode.LanguageModelChatSelector[] = [
    { vendor: "copilot" },
    { vendor: "lemonade" },
    { vendor: "ollama" },
    { vendor: "lmstudio" },
    { family: "local" },
    { family: "gpt-4o" },
    { family: "gpt-4" },
    { family: "claude-3.5-sonnet" },
    { family: "gemini-1.5-pro" },
  ];

  for (const selector of selectors) {
    try {
      const models = await vscode.lm.selectChatModels(selector);
      if (models) {
        candidates.push(...models);
      }
    } catch {}
  }

  try {
    const models = await vscode.lm.selectChatModels({});
    if (models) {
      candidates.push(...models);
    }
  } catch {}

  const seen = new Set<string>();
  const unique: vscode.LanguageModelChat[] = [];
  for (const m of candidates) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      unique.push(m);
    }
  }

  return unique;
}

export async function generateSpecContent(
  specName: string,
  fileGlob: string,
  existingContext: string,
  section: "requirements" | "design" | "tasks",
  stream: vscode.ChatResponseStream,
  preferredModel?: vscode.LanguageModelChat,
  specType: "feature" | "bugfix" | "quick" = "feature",
): Promise<string> {
  const models = await getAllCandidateModels(preferredModel);
  if (models.length === 0) {
    stream.markdown(
      "\n> **Error:** No language model available. Make sure GitHub Copilot Chat or a compatible language model provider is active.\n",
    );
    return "";
  }

  const steering = await readSteeringForContext();
  const planAgentContext = await getPlanAgentsContext();

  let promptText = "";
  if (specType === "bugfix") {
    if (section === "requirements") {
      promptText = `
You are a software engineer debugging an issue. Generate a Bug Analysis document for an issue/bug called "${specName}".
The bug affects files matching: \`${fileGlob}\`.

Structure the document with:
1. Bug Overview & Reported Symptoms
2. Expected vs Actual Behavior
3. Potential Root Cause Analysis
4. Reproduction Steps
5. Impact & Affected Components

Respond with ONLY the Markdown body (no frontmatter). Be specific and diagnostic.`;
    } else if (section === "design") {
      promptText = `
You are a software engineer. Generate a Fix Plan document for the bug "${specName}".
The bug affects files matching: \`${fileGlob}\`.

${existingContext ? `Bug Analysis context:\n${existingContext}\n` : ""}

Structure the document with:
1. Proposed Solution Strategy
2. Code Changes Required
3. Potential Side-Effects & Risks
4. Verification & Testing Strategy

Respond with ONLY the Markdown body (no frontmatter). Be specific and technical.`;
    } else {
      promptText = `
You are a software engineer. Generate a step-by-step task breakdown for fixing the bug "${specName}".
The bug affects files matching: \`${fileGlob}\`.

${existingContext ? `Context:\n${existingContext}\n` : ""}

Rules:
- Use checkbox format: \`- [ ] <!-- task:T1 --> Task title\`
- Add a \`<!-- files: ${fileGlob} -->\` comment at the top
- Include tasks for: 1. Reproducing the bug, 2. Implementing code fixes, 3. Regression testing & verification.
- Be concrete and actionable (no vague tasks)

Respond with ONLY the Markdown body (no frontmatter).`;
    }
  } else if (specType === "quick") {
    promptText = `
You are a software engineer. Generate a concise task breakdown checklist for "${specName}".
The task affects files matching: \`${fileGlob}\`.

Rules:
- Use checkbox format: \`- [ ] <!-- task:T1 --> Task title\`
- Add a \`<!-- files: ${fileGlob} -->\` comment at the top
- Group tasks logically into 2-5 actionable steps

Respond with ONLY the Markdown body (no frontmatter).`;
  } else {
    const sectionPrompts: Record<string, string> = {
      requirements: `
You are a software architect. Generate a requirements document for a feature called "${specName}".
The feature affects files matching: \`${fileGlob}\`.

Use EARS notation for acceptance criteria:
- WHEN [condition] THE SYSTEM SHALL [behavior]
- IF [precondition] WHEN [condition] THE SYSTEM SHALL [behavior]
- WHILE [state] THE SYSTEM SHALL [behavior]

Structure the document with:
1. Overview (2-3 sentences)
2. User Stories with Acceptance Criteria (at least 2 user stories)
3. Non-Functional Requirements
4. Out of Scope

Respond with ONLY the Markdown body (no frontmatter). Be specific and testable.`,

      design: `
You are a software architect. Generate a design document for a feature called "${specName}".
The feature affects files matching: \`${fileGlob}\`.

${existingContext ? `Requirements context:\n${existingContext}\n` : ""}

Structure the document with:
1. Architecture Overview
2. Components (with interfaces/types)
3. Data Flow (ASCII diagram)
4. Sequence Diagram (text format)
5. Error Handling table
6. Dependencies
7. Open Questions

Respond with ONLY the Markdown body (no frontmatter). Be specific and technical.`,

      tasks: `
You are a software architect. Generate a task breakdown for implementing the feature "${specName}".
The feature affects files matching: \`${fileGlob}\`.

${existingContext ? `Context:\n${existingContext}\n` : ""}

Rules:
- Use checkbox format: \`- [ ] <!-- task:T1 --> Task title\`
- Add a \`<!-- files: ${fileGlob} -->\` comment at the top
- Each top-level task should have 2-4 sub-tasks
- Tasks should be in implementation order
- Include a testing task and a documentation task
- Where applicable, reference workspace skills, agents, prompts, hooks, workflows, and VS Code workbench actions (e.g. \`@command:workbench.action...\`)
- Be concrete and actionable (no vague tasks)

Respond with ONLY the Markdown body (no frontmatter).`,
    };
    promptText = sectionPrompts[section] ?? "";
  }

  const systemMessage = [
    "You are an expert Software Architect & Planning Agent.",
    steering ? `Workspace Rules & Steering:\n${steering}` : "",
    planAgentContext ? `Planning Agent Tools & Capabilities:\n${planAgentContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let fullContent = "";

  for (const model of models) {
    try {
      const messages = [
        vscode.LanguageModelChatMessage.User(`${systemMessage}\n\n${promptText}`),
      ];

      const chatResponse = await model.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token,
      );

      for await (const fragment of chatResponse.text) {
        stream.markdown(fragment);
        fullContent += fragment;
      }

      if (fullContent.trim()) {
        break;
      }
    } catch (err) {
      console.warn(`Model ${model.id} failed for section ${section}:`, err);
    }
  }

  return fullContent.trim();
}

export async function generateFullSpec(
  specName: string,
  fileGlob: string,
  stream: vscode.ChatResponseStream,
  preferredModel?: vscode.LanguageModelChat,
): Promise<void> {
  const { loadSpec } = await import("../specManager.js");
  const existingSpec = await loadSpec(specName);
  const specType = existingSpec?.specType ?? "feature";
  const workflowType = existingSpec?.workflowType ?? (specType === "quick" ? "quick" : "requirements-first");

  stream.markdown(
    `## Creating ${specType.toUpperCase()} spec: **${specName}**\n\nGlob: \`${fileGlob}\`\n\n`,
  );

  // Capture existing completed task IDs before overwriting so we can restore them
  const { tasks: existingTasks } = await loadTasks(specName);
  const completedIds = new Set(
    existingTasks.filter((t) => t.completed).map((t) => t.id),
  );

  // Scaffold the files first if spec does not exist yet
  if (!existingSpec) {
    try {
      await createSpec(specName, fileGlob, specType, workflowType);
    } catch (err) {
      stream.markdown(`> **Error creating spec files:** ${err}\n`);
      return;
    }
  }

  const { writeTextFile, requirementsUri, designUri, tasksUri } = await import("../utils/fileSystem.js");
  const { serializeFrontmatter } = await import("../utils/frontmatter.js");

  let requirementsContent = "";
  let designContent = "";
  let tasksGeneratedContent = "";

  if (specType === "quick") {
    stream.markdown("### Quick Tasks\n\n");
    tasksGeneratedContent = await generateSpecContent(
      specName,
      fileGlob,
      "",
      "tasks",
      stream,
      preferredModel,
      "quick",
    );
  } else if (specType === "bugfix") {
    stream.markdown("### Bug Analysis\n\n");
    requirementsContent = await generateSpecContent(
      specName,
      fileGlob,
      "",
      "requirements",
      stream,
      preferredModel,
      "bugfix",
    );

    stream.markdown("\n\n### Fix Plan\n\n");
    designContent = await generateSpecContent(
      specName,
      fileGlob,
      requirementsContent,
      "design",
      stream,
      preferredModel,
      "bugfix",
    );

    stream.markdown("\n\n### Tasks\n\n");
    const combinedContext = `Bug Analysis:\n${requirementsContent}\n\nFix Plan:\n${designContent}`;
    tasksGeneratedContent = await generateSpecContent(
      specName,
      fileGlob,
      combinedContext,
      "tasks",
      stream,
      preferredModel,
      "bugfix",
    );
  } else {
    stream.markdown("### Requirements\n\n");
    requirementsContent = await generateSpecContent(
      specName,
      fileGlob,
      "",
      "requirements",
      stream,
      preferredModel,
      "feature",
    );

    stream.markdown("\n\n### Design\n\n");
    designContent = await generateSpecContent(
      specName,
      fileGlob,
      requirementsContent,
      "design",
      stream,
      preferredModel,
      "feature",
    );

    stream.markdown("\n\n### Tasks\n\n");
    const combinedContext = `Requirements:\n${requirementsContent}\n\nDesign:\n${designContent}`;
    tasksGeneratedContent = await generateSpecContent(
      specName,
      fileGlob,
      combinedContext,
      "tasks",
      stream,
      preferredModel,
      "feature",
    );
  }

  // Write generated content to files
  const reqUri = requirementsUri(specName);
  const dUri = designUri(specName);
  const taskFileUri = tasksUri(specName);

  if (reqUri && requirementsContent) {
    const fm = {
      name: specType === "bugfix" ? `${specName} Bug Analysis` : `${specName} Requirements`,
      applyTo: fileGlob,
      description: specType === "bugfix" ? `Bug analysis for ${specName}` : `Requirements for the ${specName} feature`,
    };
    await writeTextFile(reqUri, serializeFrontmatter(fm, requirementsContent));
  }
  if (dUri && designContent) {
    const fm = {
      name: specType === "bugfix" ? `${specName} Fix Plan` : `${specName} Design`,
      applyTo: fileGlob,
      description: specType === "bugfix" ? `Fix plan for ${specName}` : `Architecture and design for the ${specName} feature`,
    };
    await writeTextFile(dUri, serializeFrontmatter(fm, designContent));
  }
  if (taskFileUri && tasksGeneratedContent) {
    const finalTasksContent =
      completedIds.size > 0
        ? applyCompletedIds(tasksGeneratedContent, completedIds, specName)
        : tasksGeneratedContent;
    await writeTextFile(taskFileUri, finalTasksContent);
  }

  stream.markdown(
    `\n\n---\n✅ Spec files created in \`.github/specs/${specName}/\`\n`,
  );
  if (reqUri && requirementsContent) {
    stream.button({
      command: "vscode.open",
      arguments: [reqUri],
      title: specType === "bugfix" ? "Open Bug Analysis" : "Open Requirements",
    });
  }
  if (taskFileUri) {
    stream.button({
      command: "vscode.open",
      arguments: [taskFileUri],
      title: "Open Tasks",
    });
  }
  stream.button({
    command: "copilot-specs.startImplementation",
    arguments: [specName],
    title: "Start Implementation",
  });
}

export async function createPlanPromptFile(
  specName: string,
  requirementsContent: string,
  designContent: string,
  tasksContent: string,
): Promise<vscode.TextDocument> {
  const camelCaseName = specName
    .trim()
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

  const planPromptContent = [
    `# Feature Plan: ${specName}`,
    ``,
    `## Requirements`,
    requirementsContent.trim(),
    ``,
    `## Design Specification`,
    designContent.trim(),
    ``,
    `## Implementation Tasks`,
    tasksContent.trim(),
    ``,
    `---`,
    `> **Refinement & Implementation:** Edit this plan prompt as needed, then click Start Implementation.`,
  ].join("\n");

  const uri = vscode.Uri.parse(`untitled:plan-${camelCaseName}.prompt.md`);
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), planPromptContent);
  await vscode.workspace.applyEdit(edit);
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}
