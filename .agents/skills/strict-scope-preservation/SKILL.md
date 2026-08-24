---
name: strict-scope-preservation
description: >-
  Use this skill to ensure that the agent adheres strictly to the user's requested scope,
  never changing, refactoring, or touching any code, database, configuration, or files
  outside of the explicit request.
---

# Strict Scope Preservation

This skill enforces a zero-tolerance policy for out-of-scope modifications. The agent must strictly isolate changes to the exact files and lines of code necessary to solve the user's specific request.

## Rules of Engagement

1. **Do Not Touch Unrequested Files**:
   Do not modify, refactor, style, or clean up any files, variables, or functions that were not explicitly mentioned or directly required to satisfy the user's request.
   
2. **Minimize Code Footprint**:
   Keep all code edits as minimal and localized as possible. Avoid preemptive enhancements, unnecessary optimizations, or "clean-up" of adjacent code.

3. **Strict Boundaries**:
   If the user asks to analyze/modify a specific module (e.g., WhatsApp, Agenda, Kanban), do not modify other modules even if you spot an issue or a potential improvement.

4. **Verify Scoping Before Edits**:
   Before making any tool calls to edit files:
   - Match the target files against the user's explicit request.
   - Verify that no side-effects or unrelated changes are bundled in the replacement content.
