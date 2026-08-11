---
name: "{{SPEC_NAME}}"
applyTo: "{{FILE_GLOB}}"
---

# {{SPEC_NAME}} — Quick Spec

<!-- files: {{FILE_GLOB}} -->

> **Quick Spec**: All three sections (Requirements, Design, Tasks) are combined in one pass.
> Ask Copilot: *"Fill out the Requirements, Design, and Tasks sections for {{SPEC_NAME}} based on: [describe feature]"*

---

## Requirements

### User Story

**As a** <!-- role -->, **I want** <!-- goal -->, **so that** <!-- benefit -->.

### Acceptance Criteria

1. THE System SHALL <!-- behavior -->
2. WHEN <!-- condition -->, THE System SHALL <!-- behavior -->
3. WHEN <!-- condition -->, THE System SHALL <!-- behavior -->

---

## Design

### Architecture

> Describe the solution approach briefly.

### Key Components

- **<!-- Component -->**: <!-- Responsibility -->
- **<!-- Component -->**: <!-- Responsibility -->

### Data Flow

```
[User] --> [Component A] --> [Component B] --> [Storage]
```

---

## Tasks

- [ ] <!-- task:T1 --> <!-- First task --> <!-- requires:REQ-1 -->
  - [ ] 1.1 <!-- Sub-task -->
  - [ ] 1.2 <!-- Sub-task -->

- [ ] <!-- task:T2 --> <!-- Second task --> <!-- requires:REQ-1 -->
  - [ ] 2.1 <!-- Sub-task -->

- [ ] <!-- task:T3 --> Add tests
  - [ ] 3.1 Unit tests
  - [ ] 3.2 Integration tests

## Notes

> Implementation notes and decisions.
