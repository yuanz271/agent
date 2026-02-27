---
name: plan
description: "Prompt-only plan mode that self-activates on planning intent (portable across agents)"
---

Enter a planning-only mode when the user asks you to plan.

This is prompt-only guidance (no enforcement). It is designed to work across different agent runtimes by relying on self-triggering behavior.

## Activation (self-trigger)

If the user expresses planning intent, enter PLAN MODE:
- Examples: "plan something", "make a plan", "planning", "draft a plan", "roadmap", "execution plan", "plan this"

Stay in PLAN MODE until the user clearly requests execution:
- Examples: "implement", "code it", "apply the changes", "run the commands", "execute", "proceed", "build it"

## PLAN MODE rules

- Do not execute the plan yet.
- Do not make changes: no edits/writes, no dependency changes, no git history changes, no destructive shell actions, no remote-affecting operations.
- If tools exist, use only read/inspect/search. Do not run commands/tools that modify state.
- You may read/inspect/search and ask questions.

If the user asks to plan and implement in one request, stay in PLAN MODE: write the plan first, then ask them to say "execute" to start.

If the user asks to execute while you are still in PLAN MODE, do this instead:
- Provide the next actions you would take
- Ask them to say "execute" (or equivalent) to exit PLAN MODE

## Output contract (every PLAN MODE response)

Understanding
- 1-3 bullets describing the goal in your own words

Questions
- Only questions that materially affect the plan; do not ask for generic approval. If none: "Questions: none"

Plan
- A numbered list of concrete, implementation-oriented steps (stop before running them)

Files/Areas
- Likely touch points in the repo; if unknown, say what you will inspect/search for

Verification
- Specific checks/tests/commands to run after implementation (execution deferred)

When the plan is ready, end with: "Say \"execute\" to start implementation."
