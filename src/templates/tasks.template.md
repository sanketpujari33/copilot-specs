---
name: "{{SPEC_NAME}}"
applyTo: "{{FILE_GLOB}}"
---

# {{SPEC_NAME}} — Implementation Plan

<!-- files: {{FILE_GLOB}} -->

## Overview

<!-- Implementation language, key technologies, architecture pattern, and phases summary -->

## Tasks

### Phase 1: Foundation <!-- task:P1 -->

- [ ] <!-- task:T1 --> Set up core structure and types <!-- requires:REQ-1 -->
  - Create directory layout and module files
  - Define TypeScript interfaces and models
  - _Requirements: 1.1, 1.2_

  - [ ] 1.1 Define core interfaces
  - [ ] 1.2 Create directory structure

- [ ] <!-- task:T2 --> Implement core logic <!-- requires:REQ-1,REQ-2 -->
  - Write main implementation
  - Add error handling and validation
  - _Requirements: 1.3, 2.1_

  - [ ] 2.1 Write primary implementation
  - [ ] 2.2 Add error handling

### Phase 2: Integration <!-- task:P2 -->

- [ ] <!-- task:T3 --> Connect to external services <!-- requires:REQ-2 -->
  - _Requirements: 2.2, 2.3_

  - [ ] 3.1 Set up service client
  - [ ] 3.2 Handle authentication

- [ ] <!-- task:T4 --> Add tests <!-- requires:REQ-1,REQ-2 -->
  - _Requirements: 1.1, 2.1_

  - [ ] 4.1 Unit tests for core logic
  - [ ] 4.2 Integration tests

### Phase 3: Polish <!-- task:P3 -->

- [ ] <!-- task:T5 --> Update documentation <!-- requires:REQ-1 -->
  - Add inline JSDoc comments
  - Update README if needed

## Linking Hints

- Mention concrete file paths in task descriptions when known.
- Keep `task:Tn` IDs stable; links and automation use them.
- Use `requires:REQ-xx` to make requirement-task mapping explicit.
- Numbered sub-tasks (`1.1`, `1.2`) group as children of their parent task.
- Use `[x]*` to mark auto-verified tasks (e.g., covered by CI).

## Notes

> Add any implementation notes, caveats, or decisions made during development.
