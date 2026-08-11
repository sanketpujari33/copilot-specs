---
name: "{{SPEC_NAME}}"
applyTo: "{{FILE_GLOB}}"
---

# {{SPEC_NAME}} — Fix Plan

## Proposed Solution

> Describe the fix at a high level. What will change and why?

## Implementation Approach

### Option 1: <!-- Approach name --> *(Recommended)*

**Description:** <!-- Describe the approach -->

**Pros:**
- <!-- Advantage 1 -->
- <!-- Advantage 2 -->

**Cons:**
- <!-- Risk or trade-off -->

### Option 2: <!-- Alternative approach name -->

**Description:** <!-- Describe the alternative -->

**Reason not preferred:** <!-- Why Option 1 is better -->

## Changes Required

| File | Change Description |
|------|--------------------|
| `<!-- path/to/file.ts -->` | <!-- what changes and why --> |
| `<!-- path/to/file.ts -->` | <!-- what changes and why --> |

## Testing Strategy

- [ ] <!-- Unit test: describe what to test -->
- [ ] <!-- Integration test: describe the scenario -->
- [ ] <!-- Manual test: describe reproduction steps to verify fix -->
- [ ] Regression: confirm original reproduction steps no longer exhibit the bug

## Rollback Plan

> How can this change be reverted if it causes issues in production?

## Risk Assessment

- **Risk Level:** Low | Medium | High
- **Side Effects:** <!-- Any known side effects -->
- **Breaking Changes:** <!-- Yes/No — describe if yes -->
