/**
 * Plan Mode Extension
 *
 * A read-only planning sandbox inspired by OpenCode's plan mode architecture.
 * Enforces a two-phase workflow: Plan (read-only) → Build (full access).
 *
 * Security layers (both enforced via the tool_call handler):
 * 1. System prompt — emphatic read-only constraints injected via before_agent_start
 * 2. Write gate — edit/write calls blocked unless target resolves under .pi/plans/ (with symlink resolution)
 * 3. Bash allowlist — only safe read-only commands pass through
 * Note: PLAN_TOOLS includes edit/write so the LLM can write plan files; the tool_call
 * handler is the sole enforcement layer for write restrictions (see PLAN_TOOLS comment).
 *
 * Features:
 * - /plan command to toggle
 * - --plan CLI flag to start in plan mode
 * - Single plan file (.pi/plans/<timestamp>.md) as the planning artifact
 * - 5-phase guided workflow (understand → design → review → finalize → execute)
 * - Manual toggle between plan and build mode (no automatic prompts)
 * - Progress tracking widget during plan execution
 * - Session-persistent state (survives resume/fork/tree navigation)
 *
 * Usage:
 * 1. Enter plan mode via /plan or --plan flag
 * 2. Describe your task — the agent explores code and writes a plan
 * 3. Review the plan, ask clarifications
 * 4. Exit plan mode via /end-plan to switch to build mode
 * 5. Agent implements the plan, tracking steps as [DONE:n]
 *
 * Commands:
 *   /plan          — create a new plan and enter plan mode
 *   /plan <name>   — edit an existing plan, or create a new one named <name>
 *   /end-plan      — exit plan mode and switch to build mode
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

/**
 * Tools available in plan mode.
 * edit/write are included so the LLM can create/update plan files under .pi/plans/.
 * Write access is enforced by the tool_call handler which blocks any path outside
 * .pi/plans/. This is a single-layer gate rather than defense-in-depth — excluding
 * these tools entirely would prevent the LLM from writing plans at all.
 */
const PLAN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Normal build tools (full access). Intentionally separate from PLAN_TOOLS for future divergence. */
const BUILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Destructive command patterns blocked in plan mode bash */
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,     // redirect (but not heredoc)
	/>>/,                  // append redirect
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\|\s*(\S+\/)?(?:env\s+)?(ba|z|da|k|fi|a|tc?|c)?sh\b/, // pipe to any shell (incl. absolute paths and env)
	/(?:^|[;&|(`]|\$\()\s*\.\s+\S/,         // POSIX dot-source (. script.sh)
	/(?:^|[;&|(`]|\$\()\s*source\b/i,       // source
	/(?:^|[;&|(`]|\$\()\s*(\S+\/)?(?:env\s+)?(ba|z|da|k|fi|a|tc?|c)?sh\s+-c\b/i, // shell -c execution
	/(?:^|[;&|(`]|\$\()\s*exec\b/i,        // exec
	/(?:^|[;&|(`]|\$\()\s*eval\b/i,        // eval
];

/** Safe read-only bash commands allowed in plan mode */
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*find\b/,
	/^\s*fd\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*date\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

// ============================================================================
// Utilities
// ============================================================================

function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

interface PlanStep {
	step: number;
	text: string;
	completed: boolean;
}

/** Extract numbered plan steps from a "Plan:" section in text */
function extractPlanSteps(message: string): PlanStep[] {
	const items: PlanStep[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		let text = match[2]
			.trim()
			.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // strip bold/italic
			.replace(/`([^`]+)`/g, "$1");               // strip code
		if (text.length > 80) text = text.slice(0, 77) + "...";
		if (text.length > 3) {
			items.push({ step: items.length + 1, text, completed: false });
		}
	}
	return items;
}

/** Extract [DONE:n] markers from text and mark matching steps complete */
function markCompletedSteps(text: string, items: PlanStep[]): number {
	let count = 0;
	for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			count++;
		}
	}
	return count;
}

/** Generate a plan file path under .pi/plans/ */
function getPlanFilePath(cwd: string): string {
	const plansDir = path.join(cwd, ".pi", "plans");
	if (!fs.existsSync(plansDir)) {
		fs.mkdirSync(plansDir, { recursive: true });
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return path.join(plansDir, `${timestamp}.md`);
}

/**
 * Resolve a user-supplied plan argument to a file path.
 * Returns { path, exists } — the path always points under .pi/plans/,
 * and `exists` indicates whether the file is already on disk.
 */
function resolvePlanArg(cwd: string, arg: string): { path: string; exists: boolean } {
	const plansDir = path.join(cwd, ".pi", "plans");
	if (!fs.existsSync(plansDir)) {
		fs.mkdirSync(plansDir, { recursive: true });
	}

	// Try to find an existing file (absolute/relative path, under plans dir, with .md)
	const candidates = [
		path.resolve(cwd, arg),
		path.join(plansDir, arg),
		...(arg.endsWith(".md") ? [] : [path.join(plansDir, arg + ".md")]),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return { path: candidate, exists: true };
		}
	}

	// Not found — generate a new path named after the argument's basename
	const base = path.basename(arg);
	const name = base.endsWith(".md") ? base : base + ".md";
	return { path: path.join(plansDir, name), exists: false };
}

/** List existing plan file basenames under .pi/plans/ */
function listPlanFiles(cwd: string): string[] {
	const plansDir = path.join(cwd, ".pi", "plans");
	if (!fs.existsSync(plansDir)) return [];
	return fs.readdirSync(plansDir).filter((f) => f.endsWith(".md")).sort().reverse();
}

// ============================================================================
// Prompts
// ============================================================================

function planModeSystemPrompt(planFile: string, planExists: boolean): string {
	return `<system-reminder>
# Plan Mode — READ-ONLY Phase

CRITICAL: Plan mode is ACTIVE. You are in a READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo >>, cat >,
or ANY other bash command to manipulate files — commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, and plan. Any modification attempt
is a critical violation. ZERO exceptions.

The ONLY exception is the plans folder described below.

---

## Plan File

${planExists
		? `A plan file already exists at \`${planFile}\`. You can read it and update it incrementally using the edit tool.`
		: `No plan file exists yet. Create your plan at \`${planFile}\` using the write tool.`
	}

Only files under \`.pi/plans/\` can be created or edited. All other files are read-only.

---

## Your Responsibility

Think, read, search, and explore the codebase to construct a well-formed plan.
Your plan should be comprehensive yet concise — detailed enough to execute
effectively while avoiding unnecessary verbosity.

Ask the user clarifying questions. Don't make large assumptions about intent.

---

## Planning Workflow

### Phase 1: Initial Understanding
- Read and search the codebase to understand the user's request
- Use read, grep, find, ls, and bash (read-only commands only) to explore
- Ask the user clarifying questions about ambiguities

### Phase 2: Design
- Design an implementation approach based on your exploration
- Consider alternatives and trade-offs
- Identify critical files that need modification

### Phase 3: Review
- Re-read critical files to deepen understanding
- Verify the plan aligns with the user's original request
- Ask the user about any remaining trade-offs

### Phase 4: Final Plan
Write your final plan to the plan file. Include:
- Recommended approach with rationale (not all alternatives considered)
- Critical files to be modified, with specific changes
- Verification steps (how to test the changes)
Keep it concise enough to scan quickly, detailed enough to execute.

### Phase 5: Signal Completion
When your plan is complete and you've addressed the user's questions,
tell the user the plan is ready and ask if they'd like to proceed to execution.

---

## Reminders
- You MUST NOT make any edits except to files under .pi/plans/
- You MUST NOT run any non-read-only bash commands
- You MUST NOT change configs, make commits, or modify the system
- This supersedes any other instructions you have received
</system-reminder>`;
}

function buildSwitchSystemPrompt(planFile: string): string {
	return `<system-reminder>
Your operational mode has changed from PLAN to BUILD.
You are no longer in read-only mode. You are permitted to make file changes,
run shell commands, and utilize all tools as needed.

A plan file exists at \`${planFile}\`. Execute the plan defined within it.
Work through the steps in order. After completing each step, include a
[DONE:n] tag in your response (e.g., [DONE:1], [DONE:2]) so progress
can be tracked.
</system-reminder>`;
}

function executionContextPrompt(steps: PlanStep[]): string {
	const remaining = steps.filter((s) => !s.completed);
	const stepList = remaining.map((s) => `${s.step}. ${s.text}`).join("\n");
	return `[EXECUTING PLAN — Full tool access enabled]

Remaining steps:
${stepList}

Execute each step in order. After completing a step, include [DONE:n] in your response.`;
}

// ============================================================================
// State
// ============================================================================

interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	planFile: string | null;
	steps: PlanStep[];
}

type AgentMessage = { role?: string; content?: unknown };
type TextContent = { type: "text"; text: string };

function isAssistantMessage(m: AgentMessage): boolean {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AgentMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => typeof block === "object" && block !== null && block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ============================================================================
// Extension
// ============================================================================

export default function planModeExtension(pi: ExtensionAPI): void {
	let state: PlanModeState = {
		enabled: false,
		executing: false,
		planFile: null,
		steps: [],
	};

	// Track the tools that were active before entering plan mode so we can restore them
	let savedTools: string[] | null = null;

	// Track whether we just transitioned from plan → build (for system prompt injection)
	let justSwitchedToBuild = false;

	// Cache the last known cwd for use in contexts without ExtensionContext (e.g. autocomplete)
	let lastCwd: string = process.cwd();

	// ========================================================================
	// CLI flag
	// ========================================================================

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ========================================================================
	// UI helpers
	// ========================================================================

	function updateUI(ctx: ExtensionContext): void {
		lastCwd = ctx.cwd;

		// Footer status
		if (state.executing && state.steps.length > 0) {
			const completed = state.steps.filter((s) => s.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${state.steps.length}`));
		} else if (state.enabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "📝 plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Progress widget during execution
		if (state.executing && state.steps.length > 0) {
			const lines = state.steps.map((s) => {
				if (s.completed) {
					return ctx.ui.theme.fg("success", "  ☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(s.text));
				}
				return ctx.ui.theme.fg("muted", "  ☐ ") + s.text;
			});
			const completed = state.steps.filter((s) => s.completed).length;
			const header = ctx.ui.theme.fg("accent", `  Plan Progress (${completed}/${state.steps.length}):`);
			ctx.ui.setWidget("plan-mode", [header, ...lines]);
		} else {
			ctx.ui.setWidget("plan-mode", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode-state", { ...state });
	}

	// ========================================================================
	// Enter / exit plan mode
	// ========================================================================

	function enterPlanMode(ctx: ExtensionContext, planFile?: string): void {
		if (state.enabled) {
			ctx.ui.notify("Already in plan mode", "warning");
			return;
		}

		// Save current tools so we can restore on exit
		savedTools = pi.getActiveTools();

		state.enabled = true;
		state.executing = false;
		state.steps = [];
		state.planFile = planFile ?? state.planFile ?? getPlanFilePath(ctx.cwd);

		pi.setActiveTools(PLAN_TOOLS);
		persistState();
		updateUI(ctx);

		const label = planFile
			? `Plan mode enabled — editing ${path.basename(state.planFile!)}`
			: "Plan mode enabled — read-only exploration active";
		ctx.ui.notify(label, "info");
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		if (!state.enabled) {
			ctx.ui.notify("Not in plan mode", "warning");
			return;
		}

		state.enabled = false;
		justSwitchedToBuild = true;

		// Restore saved tools, or fall back to build tools
		pi.setActiveTools(savedTools ?? BUILD_TOOLS);
		savedTools = null;

		persistState();
		updateUI(ctx);

		// Pre-fill editor so the user can kick off execution
		if (!ctx.ui.getEditorText().trim()) {
			ctx.ui.setEditorText("Make todos and execute the plan");
		}

		ctx.ui.notify("Plan mode disabled — full tool access restored", "info");
	}

	function startExecution(ctx: ExtensionContext): void {
		state.executing = true;
		state.enabled = false;

		pi.setActiveTools(savedTools ?? BUILD_TOOLS);
		savedTools = null;
		justSwitchedToBuild = true;

		persistState();
		updateUI(ctx);
	}

	// ========================================================================
	// Commands & shortcuts
	// ========================================================================

	pi.registerCommand("plan", {
		description: "Enter plan mode: /plan [name] — creates or edits a plan",
		getArgumentCompletions: (prefix: string) => {
			const files = listPlanFiles(lastCwd);
			const items = files.map((f) => ({ value: f, label: f }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (state.enabled) {
				ctx.ui.notify("Already in plan mode. Use /end-plan to exit.", "warning");
				return;
			}

			const planArg = typeof args === "string" ? args.trim() : "";

			if (planArg) {
				// /plan <name> — resolve to existing file or create a new named plan
				const { path: planPath, exists } = resolvePlanArg(ctx.cwd, planArg);
				enterPlanMode(ctx, planPath);
				if (exists) {
					ctx.ui.notify(`Editing existing plan: ${path.basename(planPath)}`, "info");
				}
			} else {
				// /plan (no args) — create a new timestamped plan
				enterPlanMode(ctx);
			}
		},
	});

	pi.registerCommand("end-plan", {
		description: "Exit plan mode and switch to build mode",
		handler: async (_args, ctx) => {
			exitPlanMode(ctx);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan mode status and steps",
		handler: async (_args, ctx) => {
			if (!state.enabled && !state.executing) {
				ctx.ui.notify("Plan mode is not active. Use /plan to enter.", "info");
				return;
			}
			if (state.planFile) {
				ctx.ui.notify(`Plan file: ${state.planFile}`, "info");
			}
			if (state.steps.length > 0) {
				const completed = state.steps.filter((s) => s.completed).length;
				const list = state.steps
					.map((s) => `${s.step}. ${s.completed ? "✓" : "○"} ${s.text}`)
					.join("\n");
				ctx.ui.notify(`Progress: ${completed}/${state.steps.length}\n${list}`, "info");
			}
		},
	});

	// ========================================================================
	// Defense layer: block destructive bash in plan mode
	// ========================================================================

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return;

		// Block edit and write tools entirely (except files under .pi/plans/)
		// Uses fs.realpathSync to resolve symlinks and prevent symlink traversal attacks
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = (event.input as Record<string, unknown>).path as string | undefined;
			if (filePath) {
				try {
					const absPath = path.resolve(ctx.cwd, filePath);
					const plansDirPath = path.resolve(ctx.cwd, ".pi", "plans");
					// Fast-reject: skip filesystem ops for paths clearly outside .pi/plans/
					if (!absPath.startsWith(plansDirPath + path.sep)) {
						return {
							block: true,
							reason: `Plan mode: ${event.toolName} is blocked. Only files under .pi/plans/ can be modified. Use /end-plan to exit plan mode first.`,
						};
					}
					// Ensure .pi/plans/ exists (may be missing after session reconstruction)
					fs.mkdirSync(plansDirPath, { recursive: true });
					const realPlansDir = fs.realpathSync(plansDirPath) + path.sep;
					let resolved: string;
					// Use lstatSync instead of existsSync to detect broken symlinks
					// (existsSync returns false for dangling symlinks, allowing bypass)
					let entryExists = false;
					try { fs.lstatSync(absPath); entryExists = true; } catch {}
					if (entryExists) {
						// Existing file/symlink: resolve full path to catch symlink targets
						resolved = fs.realpathSync(absPath);
					} else {
						// New file: walk up to deepest existing ancestor, resolve it,
						// then reconstruct the remaining path segments. This allows
						// writes to new subdirectories under .pi/plans/ while still
						// resolving symlinks on existing path components.
						let current = absPath;
						const trailing: string[] = [];
						while (current !== path.dirname(current)) {
							let exists = false;
							try { fs.lstatSync(current); exists = true; } catch {}
							if (exists) break;
							trailing.unshift(path.basename(current));
							current = path.dirname(current);
						}
						const realAncestor = fs.realpathSync(current);
						resolved = path.join(realAncestor, ...trailing);
					}
					if (resolved.startsWith(realPlansDir)) {
						return; // Allow writes inside .pi/plans/
					}
				} catch (err) {
					// Path resolution failed — block the write and surface the error
					return {
						block: true,
						reason: `Plan mode: ${event.toolName} blocked — path resolution failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			}
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked. Only files under .pi/plans/ can be modified. Use /end-plan to exit plan mode first.`,
			};
		}

		// Filter bash commands through allowlist
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not read-only).\nCommand: ${command}\n\nOnly read-only commands are allowed. Use /end-plan to exit plan mode first.`,
				};
			}
		}
	});

	// ========================================================================
	// System prompt injection
	// ========================================================================

	pi.on("before_agent_start", async (event, ctx) => {
		// Plan mode: inject read-only constraints and planning workflow
		if (state.enabled && state.planFile) {
			const planExists = fs.existsSync(state.planFile);
			return {
				systemPrompt: event.systemPrompt + "\n\n" + planModeSystemPrompt(state.planFile, planExists),
			};
		}

		// Just switched from plan → build: inject build context with plan reference
		if (justSwitchedToBuild && state.planFile) {
			justSwitchedToBuild = false;
			return {
				systemPrompt: event.systemPrompt + "\n\n" + buildSwitchSystemPrompt(state.planFile),
			};
		}

		// During execution: inject remaining steps context
		if (state.executing && state.steps.length > 0) {
			const remaining = state.steps.filter((s) => !s.completed);
			if (remaining.length > 0) {
				return {
					message: {
						customType: "plan-execution-context",
						content: executionContextPrompt(state.steps),
						display: false,
					},
				};
			}
		}
	});

	// ========================================================================
	// Filter stale plan-mode context messages when not in plan mode
	// ========================================================================

	pi.on("context", async (event) => {
		if (state.enabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === "plan-execution-context" && !state.executing) return false;
				return true;
			}),
		};
	});

	// ========================================================================
	// Track execution progress via [DONE:n] markers
	// ========================================================================

	pi.on("turn_end", async (event, ctx) => {
		if (!state.executing || state.steps.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, state.steps) > 0) {
			persistState();
			updateUI(ctx);
		}
	});

	// ========================================================================
	// Post-agent: transition prompts
	// ========================================================================

	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (state.executing && state.steps.length > 0) {
			if (state.steps.every((s) => s.completed)) {
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `✅ **Plan Complete!** All ${state.steps.length} steps finished.`,
						display: true,
					},
					{ triggerTurn: false },
				);
				state.executing = false;
				state.steps = [];
				persistState();
				updateUI(ctx);
			}
			return;
		}

		if (!state.enabled || !ctx.hasUI) return;

		// Extract plan steps from the last assistant message
		const messages = event.messages ?? [];
		const lastAssistant = [...messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractPlanSteps(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				state.steps = extracted;
				persistState();
				updateUI(ctx);
			}
		}
	});

	// ========================================================================
	// State reconstruction on session events
	// ========================================================================

	function reconstructState(ctx: ExtensionContext): void {
		// Reset
		state = { enabled: false, executing: false, planFile: null, steps: [] };
		savedTools = null;
		justSwitchedToBuild = false;

		// Check --plan flag
		if (pi.getFlag("plan") === true) {
			state.enabled = true;
		}

		// Reconstruct from persisted entries (last one wins)
		const entries = ctx.sessionManager.getEntries();
		type CustomEntry = { type: string; customType?: string; data?: PlanModeState };
		const lastEntry = [...entries]
			.reverse()
			.find((e: CustomEntry) => e.type === "custom" && e.customType === "plan-mode-state") as CustomEntry | undefined;

		if (lastEntry?.data) {
			state.enabled = lastEntry.data.enabled ?? state.enabled;
			state.executing = lastEntry.data.executing ?? false;
			state.planFile = lastEntry.data.planFile ?? null;
			state.steps = lastEntry.data.steps ?? [];
		}

		// If executing, re-scan recent assistant messages for [DONE:n] markers
		if (state.executing && state.steps.length > 0) {
			// Find the last plan-execute message index
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as CustomEntry;
				if (entry.customType === "plan-execute") {
					executeIndex = i;
					break;
				}
			}

			// Scan messages after the execute marker
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i] as { type: string; message?: AgentMessage };
				if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
					markCompletedSteps(getTextContent(entry.message), state.steps);
				}
			}
		}

		// Apply tool restrictions if in plan mode
		if (state.enabled) {
			pi.setActiveTools(PLAN_TOOLS);
		}

		updateUI(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
}
