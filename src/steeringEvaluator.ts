import * as vscode from "vscode";
import * as path from "node:path";
import { parseFrontmatter } from "./utils/frontmatter.js";

export class SteeringEvaluator {
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("copilot-specs-evaluator");
  }

  public get collection(): vscode.DiagnosticCollection {
    return this.diagnosticCollection;
  }

  public async evaluateDocument(
    document: vscode.TextDocument,
  ): Promise<vscode.Diagnostic[]> {
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const content = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // 1. Evaluate SKILL.md files
    if (fileName.toUpperCase() === "SKILL.MD") {
      this.evaluateSkillDocument(document, content, diagnostics);
    }
    // 2. Evaluate Prompt files (.prompt.md)
    else if (fileName.endsWith(".prompt.md")) {
      this.evaluatePromptDocument(document, content, diagnostics);
    }
    // 3. Evaluate Instructions / Rules files (.instructions.md, copilot-instructions.md, AGENTS.md)
    else if (
      fileName.endsWith(".instructions.md") ||
      fileName === "copilot-instructions.md" ||
      fileName === "AGENTS.md"
    ) {
      this.evaluateInstructionsDocument(document, content, diagnostics);
    }
    // 4. Evaluate Agent files (.agent.md, AGENT.md)
    else if (fileName.endsWith(".agent.md") || fileName === "AGENT.md") {
      this.evaluateAgentDocument(document, content, diagnostics);
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    return diagnostics;
  }

  public async evaluateFileUri(uri: vscode.Uri): Promise<vscode.Diagnostic[]> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return this.evaluateDocument(doc);
    } catch {
      return [];
    }
  }

  public async evaluateWorkspace(): Promise<number> {
    const files = await vscode.workspace.findFiles(
      "{.github/**,.kiro/**,**/*.prompt.md,**/*.instructions.md,**/SKILL.md,**/AGENT.md,**/AGENTS.md}",
      "{node_modules,dist,.git}/**",
    );

    let totalDiagnostics = 0;
    for (const uri of files) {
      const diags = await this.evaluateFileUri(uri);
      totalDiagnostics += diags.length;
    }
    return totalDiagnostics;
  }

  private evaluateSkillDocument(
    document: vscode.TextDocument,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);

    // Frontmatter validation
    if (!frontmatter.name) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          "Skill file is missing required YAML frontmatter field: 'name'.",
          vscode.DiagnosticSeverity.Error,
        ),
      );
    } else if (
      typeof frontmatter.name === "string" &&
      !/^[a-z0-9-]+$/.test(frontmatter.name)
    ) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          `Skill name '${frontmatter.name}' should be lowercase kebab-case (e.g. 'my-skill-name').`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }

    if (!frontmatter.description) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          "Skill file is missing required YAML frontmatter field: 'description'. Description is used by Copilot for domain matching.",
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }

    // Line count check (> 500 lines warning)
    if (document.lineCount > 500) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(
            document.lineCount - 1,
            0,
            document.lineCount - 1,
            1,
          ),
          `Skill file exceeds 500 lines (${document.lineCount} lines). Consider moving detailed technical references into a 'references/' directory.`,
          vscode.DiagnosticSeverity.Information,
        ),
      );
    }
  }

  private evaluatePromptDocument(
    document: vscode.TextDocument,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);

    if (!frontmatter.description && !frontmatter.name) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          "Prompt file should include frontmatter metadata with 'name' and 'description'.",
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }

    if (content.trim().length < 20) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          "Prompt template is very short. Provide explicit instructions, context requirements, and output formats.",
          vscode.DiagnosticSeverity.Information,
        ),
      );
    }
  }

  private evaluateInstructionsDocument(
    document: vscode.TextDocument,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    const fileName = path.basename(document.uri.fsPath);

    if (fileName === "copilot-instructions.md") {
      const hasStart = content.includes("<!-- copilot-specs:steering:start -->");
      const hasEnd = content.includes("<!-- copilot-specs:steering:end -->");

      if (!hasStart || !hasEnd) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
            "copilot-instructions.md is missing managed steering markers (<!-- copilot-specs:steering:start --> ... <!-- copilot-specs:steering:end -->).",
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    if (content.trim().length === 0) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          "Instructions file is empty.",
          vscode.DiagnosticSeverity.Warning,
        ),
      );
    }
  }

  private evaluateAgentDocument(
    document: vscode.TextDocument,
    content: string,
    diagnostics: vscode.Diagnostic[],
  ): void {
    if (
      !content.toLowerCase().includes("role") &&
      !content.toLowerCase().includes("agent")
    ) {
      diagnostics.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, document.lineAt(0).text.length || 1),
          "Agent definition should clearly specify role, capabilities, and tool permissions.",
          vscode.DiagnosticSeverity.Information,
        ),
      );
    }
  }

  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
  }
}

/**
 * Code Action Provider for Quick Fixes on Steering Evaluation Diagnostics
 */
export class SteeringCodeActionProvider implements vscode.CodeActionProvider {
  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.message.includes("steering markers")) {
        const fix = new vscode.CodeAction(
          "Add copilot-specs steering markers",
          vscode.CodeActionKind.QuickFix,
        );
        fix.edit = new vscode.WorkspaceEdit();
        const markers = `\n\n<!-- copilot-specs:steering:start -->\n\n<!-- copilot-specs:steering:end -->\n`;
        fix.edit.insert(
          document.uri,
          new vscode.Position(document.lineCount, 0),
          markers,
        );
        fix.diagnostics = [diagnostic];
        actions.push(fix);
      }

      if (diagnostic.message.includes("missing required YAML frontmatter")) {
        const fix = new vscode.CodeAction(
          "Add frontmatter scaffold",
          vscode.CodeActionKind.QuickFix,
        );
        fix.edit = new vscode.WorkspaceEdit();
        const name = path
          .basename(path.dirname(document.uri.fsPath))
          .toLowerCase();
        const header = `---\nname: ${name}\ndescription: "Description of ${name} skill"\n---\n\n`;
        fix.edit.insert(document.uri, new vscode.Position(0, 0), header);
        fix.diagnostics = [diagnostic];
        actions.push(fix);
      }

      if (diagnostic.message.toLowerCase().includes("llm analysis error")) {
        const disabledFix = new vscode.CodeAction(
          "Implement suggestions",
          vscode.CodeActionKind.QuickFix,
        );
        disabledFix.disabled = { 
          reason: "Implement suggestions is unavailable for LLM analysis error diagnostics. Run Analyze again." 
        };
        disabledFix.diagnostics = [diagnostic];
        actions.push(disabledFix);

        const runAnalyzeFix = new vscode.CodeAction(
          "Run Analyze again",
          vscode.CodeActionKind.QuickFix,
        );
        runAnalyzeFix.command = {
          command: "copilot-specs.evaluateSteeringFile",
          title: "Run Analyze again",
          arguments: [document.uri],
        };
        runAnalyzeFix.diagnostics = [diagnostic];
        actions.push(runAnalyzeFix);
      }
    }

    return actions;
  }
}
