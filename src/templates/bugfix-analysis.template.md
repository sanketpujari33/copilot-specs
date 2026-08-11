---
name: "{{SPEC_NAME}}"
applyTo: "{{FILE_GLOB}}"
---

# {{SPEC_NAME}} — Bug Analysis

## Bug Report

**Summary:** <!-- One-line description of the bug -->
**Severity:** Critical | High | Medium | Low
**Reported By:** <!-- Person or system -->
**Reported At:** <!-- Date -->

## Reproduction Steps

1. <!-- Step 1 -->
2. <!-- Step 2 -->
3. Observe: <!-- What actually happens -->
4. Expected: <!-- What should happen -->

## Root Cause Analysis

> Identify the root cause. What in the codebase causes this behavior?

### Investigation Notes

- [ ] Checked: <!-- area 1 -->
- [ ] Checked: <!-- area 2 -->
- [ ] Checked: <!-- area 3 -->

### Root Cause

<!-- Describe the confirmed root cause in detail. -->

**Affected Files:**
- `<!-- path/to/file.ts -->` — <!-- reason -->

## Impact Assessment

- **Affected Users:** <!-- scope — all users / specific role / specific feature -->
- **Affected Components:** <!-- list components -->
- **Data Impact:** <!-- Yes/No + details on data corruption or loss risk -->
- **Security Impact:** <!-- Yes/No + details -->

## Related Requirements

<!-- Which requirement(s) does this bug violate? -->
- WHEN <!-- condition -->, THE System SHALL <!-- behavior --> — **VIOLATED**

## Non-Functional Impact

- **Performance:** <!-- Does this bug cause perf regression? -->
- **Reliability:** <!-- Does this cause crashes or data loss? -->
