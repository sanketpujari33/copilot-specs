import { TodoTemplate } from "./types.js";

/**
 * Minimal glob match: supports **, *, ?, character classes
 */
export function matchGlob(str: string, glob: string): boolean {
  const normalizedStr = str.replace(/\\/g, "/");
  const normalizedGlob = glob.replace(/\\/g, "/");

  const regStr = normalizedGlob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regStr}$`).test(normalizedStr);
}

/**
 * Service for matching files against todo templates
 */
export class TemplateMatcher {
  /**
   * Check if a file matches a specific template
   */
  public matchesTemplate(
    relativePath: string,
    fileContent: string,
    template: TodoTemplate
  ): boolean {
    // Branch-level templates don't match files directly for per-file todos
    if (template.branchLevel || !template.applyTo) {
      return false;
    }

    // Check if file path matches the glob pattern
    const pathMatches = matchGlob(relativePath, template.applyTo);

    if (!pathMatches) {
      return false;
    }

    // Check if file contains required content (if specified)
    if (template.fileContains) {
      if (!fileContent.includes(template.fileContains)) {
        return false;
      }
    }

    // Check if file does NOT contain excluded content (if specified)
    if (template.excludeFileContains) {
      if (fileContent.includes(template.excludeFileContains)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get all templates that match a given file
   */
  public getMatchingTemplates(
    relativePath: string,
    fileContent: string,
    templates: TodoTemplate[]
  ): TodoTemplate[] {
    return templates.filter((template) =>
      this.matchesTemplate(relativePath, fileContent, template)
    );
  }

  /**
   * Quick check if a file path might match any template (path only, no content check)
   * Useful for initial filtering before reading file content
   */
  public pathMatchesAnyTemplate(
    relativePath: string,
    templates: TodoTemplate[]
  ): boolean {
    // Only check file-based templates (not branch-level)
    const fileTemplates = templates.filter((t) => t.applyTo && !t.branchLevel);
    return fileTemplates.some((template) =>
      matchGlob(relativePath, template.applyTo!)
    );
  }
}
