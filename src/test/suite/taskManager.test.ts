import * as assert from "node:assert/strict";
import {
  parseTasks,
  calculateProgress,
  validateTaskMarkdown,
  extractRequirementIdsFromText,
} from "../../taskManager.js";

suite("taskManager", () => {
  suite("parseTasks", () => {
    test("parses a simple uncompleted task", () => {
      const { tasks } = parseTasks("- [ ] Do something", "mySpec");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, "Do something");
      assert.equal(tasks[0].completed, false);
      assert.equal(tasks[0].id, "T1");
      assert.equal(tasks[0].specName, "mySpec");
    });

    test("parses a completed task with [x]", () => {
      const { tasks } = parseTasks("- [x] Done", "mySpec");
      assert.equal(tasks[0].completed, true);
    });

    test("parses capital X as completed", () => {
      const { tasks } = parseTasks("- [X] Done", "mySpec");
      assert.equal(tasks[0].completed, true);
    });

    test("parses [*] as completed", () => {
      const { tasks } = parseTasks("- [*] Done", "mySpec");
      assert.equal(tasks[0].completed, true);
      assert.equal(tasks[0].inProgress, false);
      assert.equal(tasks[0].queued, false);
    });

    test("parses [-] as in-progress", () => {
      const { tasks } = parseTasks("- [-] Working on it", "mySpec");
      assert.equal(tasks[0].completed, false);
      assert.equal(tasks[0].inProgress, true);
      assert.equal(tasks[0].queued, false);
    });

    test("parses [~] as queued", () => {
      const { tasks } = parseTasks("- [~] Coming up", "mySpec");
      assert.equal(tasks[0].completed, false);
      assert.equal(tasks[0].inProgress, false);
      assert.equal(tasks[0].queued, true);
    });

    test("parses [ ]* as optional", () => {
      const { tasks } = parseTasks("- [ ]* Optional task", "mySpec");
      assert.equal(tasks[0].completed, false);
      assert.equal(tasks[0].optional, true);
    });

    test("parses [-]* as in-progress and optional", () => {
      const { tasks } = parseTasks("- [-]* Working on it optional", "mySpec");
      assert.equal(tasks[0].inProgress, true);
      assert.equal(tasks[0].optional, true);
    });

    test("parses [~]* as queued and optional", () => {
      const { tasks } = parseTasks("- [~]* Queued optional", "mySpec");
      assert.equal(tasks[0].queued, true);
      assert.equal(tasks[0].optional, true);
    });

    test("parses [*]* as completed and optional", () => {
      const { tasks } = parseTasks("- [*]* Optional and done", "mySpec");
      assert.equal(tasks[0].completed, true);
      assert.equal(tasks[0].optional, true);
    });

    test("extracts task ID from HTML comment", () => {
      const { tasks } = parseTasks(
        "- [ ] <!-- task:T3 --> Implement feature",
        "mySpec",
      );
      assert.equal(tasks[0].id, "T3");
      assert.equal(tasks[0].title, "Implement feature");
    });

    test("extracts task ID from bold prefix", () => {
      const { tasks } = parseTasks("- [ ] **T5**: My task", "mySpec");
      assert.equal(tasks[0].id, "T5");
    });

    test("extracts task ID from colon prefix", () => {
      const { tasks } = parseTasks("- [ ] T11: My task", "mySpec");
      assert.equal(tasks[0].id, "T11");
    });

    test("auto-assigns sequential IDs when no explicit ID", () => {
      const content = "- [ ] First\n- [ ] Second\n- [ ] Third";
      const { tasks } = parseTasks(content, "mySpec");
      assert.equal(tasks[0].id, "T1");
      assert.equal(tasks[1].id, "T2");
      assert.equal(tasks[2].id, "T3");
    });

    test("extracts requirement IDs from requires comment", () => {
      const { tasks } = parseTasks(
        "- [ ] <!-- task:T1 --> Build UI <!-- requires:REQ-01,REQ-02 -->",
        "mySpec",
      );
      assert.deepEqual(tasks[0].requirementIds, ["REQ-01", "REQ-02"]);
      assert.equal(tasks[0].title, "Build UI");
    });

    test("parses subtasks indented under a task", () => {
      const content = "- [ ] Parent task\n  - [x] Sub done\n  - [ ] Sub todo";
      const { tasks } = parseTasks(content, "mySpec");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].subTasks.length, 2);
      assert.equal(tasks[0].subTasks[0].completed, true);
      assert.equal(tasks[0].subTasks[1].completed, false);
    });

    test("skips YAML frontmatter block", () => {
      const content = "---\nname: test\n---\n- [ ] Task one";
      const { tasks } = parseTasks(content, "mySpec");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, "Task one");
    });

    test("extracts files comment as fileGlob", () => {
      const content = "<!-- files: src/**/*.ts -->\n- [ ] Task";
      const { tasks, fileGlob } = parseTasks(content, "mySpec");
      assert.equal(fileGlob, "src/**/*.ts");
      assert.equal(tasks.length, 1);
    });

    test("returns undefined fileGlob when no files comment", () => {
      const { fileGlob } = parseTasks("- [ ] Task", "mySpec");
      assert.equal(fileGlob, undefined);
    });

    test("handles empty content", () => {
      const { tasks, fileGlob } = parseTasks("", "mySpec");
      assert.equal(tasks.length, 0);
      assert.equal(fileGlob, undefined);
    });

    test("handles multiple tasks with mixed completion", () => {
      const content = "- [ ] T1\n- [x] T2\n- [ ] T3";
      const { tasks } = parseTasks(content, "mySpec");
      assert.equal(tasks.length, 3);
      assert.equal(tasks[1].completed, true);
    });

    test("normalises CRLF line endings", () => {
      const { tasks } = parseTasks(
        "- [ ] Task one\r\n- [x] Task two\r\n",
        "mySpec",
      );
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].title, "Task one");
    });

    test("strips title whitespace", () => {
      const { tasks } = parseTasks("- [ ]   Padded title   ", "mySpec");
      assert.equal(tasks[0].title, "Padded title");
    });
  });

  suite("calculateProgress", () => {
    test("returns zero for empty task list", () => {
      const p = calculateProgress([]);
      assert.equal(p.total, 0);
      assert.equal(p.completed, 0);
    });

    test("counts completed tasks correctly", () => {
      const { tasks } = parseTasks(
        "- [x] Done\n- [ ] Pending\n- [x] Also done",
        "mySpec",
      );
      const p = calculateProgress(tasks);
      assert.equal(p.total, 3);
      assert.equal(p.completed, 2);
    });

    test("all tasks completed", () => {
      const { tasks } = parseTasks("- [x] A\n- [x] B", "mySpec");
      const p = calculateProgress(tasks);
      assert.equal(p.total, 2);
      assert.equal(p.completed, 2);
    });

    test("no tasks completed", () => {
      const { tasks } = parseTasks("- [ ] A\n- [ ] B", "mySpec");
      const p = calculateProgress(tasks);
      assert.equal(p.total, 2);
      assert.equal(p.completed, 0);
    });
  });

  suite("extractRequirementIdsFromText (requirement inference)", () => {
    test("extracts REQ-XX style IDs", () => {
      const ids = extractRequirementIdsFromText("Implement REQ-01 and REQ-02");
      assert.deepEqual(ids, ["REQ-01", "REQ-02"]);
    });

    test("extracts R-number style IDs", () => {
      const ids = extractRequirementIdsFromText("See R1 and R2 for context");
      assert.deepEqual(ids, ["R1", "R2"]);
    });

    test("deduplicates repeated IDs", () => {
      const ids = extractRequirementIdsFromText(
        "REQ-01 is referenced again as REQ-01",
      );
      assert.deepEqual(ids, ["REQ-01"]);
    });

    test("returns empty array when no IDs present", () => {
      const ids = extractRequirementIdsFromText("No requirement ids here");
      assert.deepEqual(ids, []);
    });

    test("inference is applied in parseTasks when no explicit requires comment", () => {
      const { tasks } = parseTasks("- [ ] Implement REQ-03 logic", "mySpec");
      assert.deepEqual(tasks[0].requirementIds, ["REQ-03"]);
    });

    test("explicit requires comment takes precedence over inference", () => {
      const { tasks } = parseTasks(
        "- [ ] <!-- task:T1 --> Implement REQ-03 logic <!-- requires:REQ-01 -->",
        "mySpec",
      );
      // Only REQ-01 from the explicit comment, not REQ-03 inferred from title
      assert.deepEqual(tasks[0].requirementIds, ["REQ-01"]);
    });
  });

  suite("validateTaskMarkdown", () => {
    test("returns no issues for valid content", () => {
      const content =
        "- [ ] <!-- task:T1 --> Do something <!-- requires:REQ-01 -->\n  - [ ] Sub task";
      const issues = validateTaskMarkdown(content);
      assert.equal(issues.length, 0);
    });

    test("detects invalid checkbox marker", () => {
      const issues = validateTaskMarkdown("- [?] Some task");
      assert.equal(issues.length, 1);
      assert.equal(issues[0].severity, "error");
      assert.match(issues[0].message, /Invalid checkbox marker/);
    });

    test("detects duplicate task IDs", () => {
      const content =
        "- [ ] <!-- task:T1 --> First\n- [ ] <!-- task:T1 --> Second";
      const issues = validateTaskMarkdown(content);
      const dupIssue = issues.find((i) =>
        i.message.includes("Duplicate task ID"),
      );
      assert.ok(dupIssue, "expected a duplicate ID issue");
      assert.equal(dupIssue.severity, "error");
    });

    test("detects malformed requires comment (space before colon)", () => {
      const issues = validateTaskMarkdown(
        "- [ ] Task <!-- requires : REQ-01 -->",
      );
      const issue = issues.find((i) =>
        i.message.includes("Malformed requires"),
      );
      assert.ok(issue, "expected a malformed requires issue");
      assert.equal(issue.severity, "warning");
    });

    test("detects unclosed HTML comment", () => {
      const issues = validateTaskMarkdown("- [ ] Task <!-- unclosed");
      const issue = issues.find((i) => i.message.includes("Unclosed HTML"));
      assert.ok(issue, "expected an unclosed comment issue");
      assert.equal(issue.severity, "error");
    });

    test("skips frontmatter when validating", () => {
      const content = "---\nname: my-spec\n---\n- [ ] <!-- task:T1 --> Valid";
      const issues = validateTaskMarkdown(content);
      assert.equal(issues.length, 0);
    });

    test("reports correct 0-based line numbers", () => {
      const content = "- [ ] <!-- task:T1 --> First\n- [?] Bad marker";
      const issues = validateTaskMarkdown(content);
      assert.equal(issues[0].line, 1);
    });
  });
});
