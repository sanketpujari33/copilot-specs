---
name: "{{SPEC_NAME}}"
applyTo: "{{FILE_GLOB}}"
---

# {{SPEC_NAME}} — Design

## Overview

### Purpose

> High-level description of the solution approach (2–3 sentences).

### Key Design Goals

1. <!-- Goal 1 — e.g., Performance: sub-200ms response -->
2. <!-- Goal 2 — e.g., Extensibility: easy to add new providers -->
3. <!-- Goal 3 — e.g., Testability: all logic unit-testable -->

### Architecture Style

> Describe the pattern used (e.g., event-driven, layered, microservice, MVC, etc.)

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| <!-- e.g., Storage --> | <!-- e.g., SQLite --> | <!-- e.g., Lightweight, no server needed --> |
| <!-- e.g., API Layer --> | <!-- e.g., Express.js --> | <!-- e.g., Familiar, minimal overhead --> |

## Storage and Files

- Spec files path(s): `.github/specs/{{SPEC_NAME}}/`
- Cache/metadata files: <!-- optional, e.g., .copilot-specs-cache/ -->
- External config inputs: <!-- optional -->

## Components

### Component 1: <!-- Name -->

**Responsibility:** <!-- What this component does -->

**Interface:**

```typescript
// Key types, interfaces, or function signatures
```

### Component 2: <!-- Name -->

**Responsibility:** <!-- What this component does -->

### Integration Points

- Commands/UI entry points: <!-- VS Code commands, API routes, etc. -->
- Background triggers/watchers: <!-- file watcher, event bus, cron -->
- External dependencies: <!-- language model, DB, service -->

## Data Flow

```
[Client] --> [Component A] --> [Component B] --> [Data Store]
            <-- response ----  <-- result -----
```

## Sequence Diagram

```mermaid
sequenceDiagram
    Actor->>System: request
    System->>Service: process
    Service->>Store: read/write
    Store-->>Service: result
    Service-->>System: response
    System-->>Actor: output
```

## Error Handling

| Scenario | Handling Strategy |
|---|---|
| <!-- error case --> | <!-- how it's handled --> |
| <!-- error case --> | <!-- how it's handled --> |

## Dependencies

- <!-- External library or service and why it's needed -->

## Traceability

- Requirement 1 → <!-- component(s) and flow(s) that implement it -->
- Requirement 2 → <!-- component(s) and flow(s) that implement it -->

## Open Questions

- [ ] <!-- Decision to be made -->
- [ ] <!-- Assumption to validate -->
