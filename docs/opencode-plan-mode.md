# OpenCode "Plan Mode" — Architecture Summary

OpenCode implements a **two-agent architecture** (`plan` agent → `build` agent) with an explicit planning phase before implementation. There are two variants: a **legacy mode** and an **experimental mode** (behind a `OPENCODE_EXPERIMENTAL_PLAN_MODE` flag).

---

## 1. Core Concept

Plan mode is a **read-only sandbox** where the LLM can only read/search the codebase and write to a single plan file (`.opencode/plans/<timestamp>-<slug>.md`). It prevents accidental edits during the thinking phase.

---

## 2. Agents

Defined in `packages/opencode/src/agent/agent.ts`:

| Agent | Role | Key Permissions |
|-------|------|-----------------|
| **`build`** | Default agent. Full edit/execute. | Has `plan_enter: allow` so it can suggest switching to plan mode |
| **`plan`** | Read-only planning. | `plan_exit: allow`, all `edit: deny` except plan files (`*.md` under `.opencode/plans/`) |
| **`explore`** | Sub-agent (read-only). | Only `grep`, `glob`, `list`, `bash`, `read`, `codesearch`, `webfetch`, `websearch` |
| **`general`** | Sub-agent (full tools). | Used in Phase 2 of planning for design work |

---

## 3. Plan Mode System Prompt (`plan.txt`)

Located at `packages/opencode/src/session/prompt/plan.txt`. This is injected as a `<system-reminder>` when the agent is `plan`:

**Key constraints:**
- **CRITICAL READ-ONLY**: "STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes"
- Commands may ONLY read/inspect
- "This ABSOLUTE CONSTRAINT overrides ALL other instructions"
- "ZERO exceptions"

**Responsibilities:**
- Think, read, search, delegate explore sub-agents
- Construct a "well-formed plan" — comprehensive yet concise
- Ask the user clarifying questions; don't make large assumptions

---

## 4. Experimental Plan Mode (Enhanced Workflow)

When `OPENCODE_EXPERIMENTAL_PLAN_MODE` is enabled, a much more detailed inline prompt is injected (in `prompt.ts` lines 1374–1451). This defines a **5-phase workflow**:

| Phase | Goal | Details |
|-------|------|---------|
| **Phase 1: Initial Understanding** | Explore codebase | Launch up to 3 `explore` sub-agents **in parallel**. Use `question` tool to clarify ambiguities. |
| **Phase 2: Design** | Design approach | Launch `general` sub-agent(s) (up to 1) to create implementation plan. Provide context from Phase 1. |
| **Phase 3: Review** | Validate alignment | Read critical files identified by agents. Use `question` tool for remaining questions. |
| **Phase 4: Final Plan** | Write plan file | Only recommended approach (not alternatives). Include file paths, verification steps. |
| **Phase 5: Exit** | Call `plan_exit` tool | Turn must end with either a question or `plan_exit`. |

**Plan file rules:**
- Stored at `.opencode/plans/<timestamp>-<slug>.md` (or `~/.opencode/data/plans/` if no VCS)
- Only file allowed to be edited during plan mode
- Must be concise enough to scan quickly, detailed enough to execute

---

## 5. Transition Tools

Defined in `packages/opencode/src/tool/plan.ts`:

### `plan_enter` (Build → Plan)
- **Description** (`plan-enter.txt`): Suggests switching when user request is complex, involves multiple files, or architectural decisions. Skipped for simple tasks.
- Creates a synthetic user message: *"User has requested to enter plan mode. Switch to plan mode and begin planning."*
- Asks user confirmation via `Question.ask`

### `plan_exit` (Plan → Build)
- **Description** (`plan-exit.txt`): Called after plan is finalized and questions answered.
- Creates a synthetic user message: *"The plan at {path} has been approved, you can now edit files. Execute the plan"*
- Asks user confirmation: "Would you like to switch to the build agent and start implementing?"

---

## 6. Build-Switch Prompt (`build-switch.txt`)

Injected when transitioning from plan → build agent:

> *"Your operational mode has changed from plan to build. You are no longer in read-only mode. You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed."*

In experimental mode, this is augmented with: *"A plan file exists at {path}. You should execute on the plan defined within it"*

---

## 7. Anthropic-Specific Reminder (`plan-reminder-anthropic.txt`)

A longer, more structured prompt used specifically for Anthropic models. It includes:
- A **plan file info** section with the file path and whether it already exists
- The full **5-phase enhanced planning workflow** (same as experimental mode)
- Sub-agent orchestration guidance with parallel execution patterns
- Explicit instruction: *"Do NOT use question tool to ask 'Is this plan okay?' — that's what plan_exit does"*

---

## 8. Permission Enforcement

The plan agent's permission ruleset provides a hard backstop beyond the prompt:

```ts
edit: {
  "*": "deny",  // deny all edits
  ".opencode/plans/*.md": "allow",  // except plan files
}
plan_exit: "allow"
question: "allow"
```

This means even if the LLM ignores the prompt constraints, the tool permission system will deny file edits.

---

## Key Design Takeaways

1. **Defense in depth**: Read-only constraint is enforced at 3 levels — system prompt (repeated emphatically), tool permissions, and file path restrictions
2. **Sub-agent parallelism**: Plan mode encourages launching multiple explore agents in parallel for faster codebase understanding
3. **Structured workflow**: The 5-phase process prevents premature implementation by forcing exploration → design → review → write → confirm
4. **User in the loop**: Questions are asked throughout; the plan requires explicit approval before switching to build mode
5. **Single artifact**: All planning output goes to one markdown file, which becomes the implementation blueprint for the build agent
