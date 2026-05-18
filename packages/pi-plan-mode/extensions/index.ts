/**
 * Plan Mode Extension
 *
 * True approval-gated plan mode for pi.
 *
 * Commands:
 * - /plan              toggle plan mode
 * - /plan on|off       explicitly enable/disable
 * - /plan approve      approve the pending plan and execute it
 * - /plan execute      same as approve when a pending plan exists
 * - /plan reject       reject the pending plan and stay in plan mode
 * - /plan status       show mode, approval state, and tracked steps
 * - /plan clear        clear tracked steps and approval state
 * - /todos             show current plan progress
 *
 * Shortcut:
 * - Ctrl+Alt+P         toggle plan mode
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const CORE_PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const READ_ONLY_TOOL_NAMES = new Set([
	...CORE_PLAN_TOOLS,
	"question",
	"questionnaire",
	"context7_resolve_library_id",
	"context7_query_docs",
]);
const READ_ONLY_TOOL_PREFIXES = ["context7_"];
const DEFAULT_RESTORE_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write"];
const PLAN_PROGRESS_TOOL = "plan_progress";
const PLAN_PROGRESS_ACTIONS = ["complete", "uncomplete", "complete_all", "reset"] as const;

type ApprovalState = "none" | "pending" | "approved";

type PlanState = {
	enabled?: boolean;
	executing?: boolean;
	approvalState?: ApprovalState;
	todos?: TodoItem[];
	approvedPlanText?: string;
	toolsBeforePlan?: string[];
};

function isAssistantMessage(message: AgentMessage | undefined): message is AssistantMessage {
	return message?.role === "assistant" && Array.isArray((message as AssistantMessage).content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function isReadOnlyToolName(toolName: string): boolean {
	return READ_ONLY_TOOL_NAMES.has(toolName) || READ_ONLY_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function formatPlan(todos: TodoItem[]): string {
	if (todos.length === 0) return "No tracked plan steps.";
	return todos.map((item) => `${item.step}. ${item.text}`).join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let approvalState: ApprovalState = "none";
	let todoItems: TodoItem[] = [];
	let approvedPlanText: string | undefined;
	let toolsBeforePlan: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in approval-gated plan mode (read-only until you approve a plan)",
		type: "boolean",
		default: false,
	});

	function availableToolNames(): Set<string> {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	}

	function getPlanToolNames(): string[] {
		const available = availableToolNames();
		const activeReadOnly = pi.getActiveTools().filter((name) => available.has(name) && isReadOnlyToolName(name));
		const coreReadOnly = CORE_PLAN_TOOLS.filter((name) => available.has(name));
		return unique([...activeReadOnly, ...coreReadOnly]);
	}

	function restoreTools(): void {
		const available = availableToolNames();
		const restore = (toolsBeforePlan && toolsBeforePlan.length > 0 ? toolsBeforePlan : DEFAULT_RESTORE_TOOLS).filter(
			(name) => available.has(name) && name !== PLAN_PROGRESS_TOOL,
		);

		if (restore.length > 0) pi.setActiveTools(unique(restore));
		toolsBeforePlan = undefined;
	}

	function activateProgressTool(): void {
		if (!availableToolNames().has(PLAN_PROGRESS_TOOL)) return;
		pi.setActiveTools(unique([...pi.getActiveTools(), PLAN_PROGRESS_TOOL]));
	}

	function deactivateProgressTool(): void {
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes(PLAN_PROGRESS_TOOL)) return;

		const available = availableToolNames();
		const withoutProgressTool = activeTools.filter((name) => name !== PLAN_PROGRESS_TOOL && available.has(name));
		const fallbackTools = DEFAULT_RESTORE_TOOLS.filter((name) => available.has(name));
		pi.setActiveTools(unique(withoutProgressTool.length > 0 ? withoutProgressTool : fallbackTools));
	}

	function applyPlanTools(ctx?: ExtensionContext): void {
		const tools = getPlanToolNames();
		if (tools.length === 0) {
			ctx?.ui.notify("Plan mode could not find any read-only tools to enable.", "error");
			return;
		}
		pi.setActiveTools(tools);
	}

	function persistState(): void {
		pi.appendEntry<PlanState>("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			approvalState,
			todos: todoItems,
			approvedPlanText,
			toolsBeforePlan,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (executionMode && todoItems.length > 0) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "📋 executing"));
		} else if (planModeEnabled && approvalState === "pending" && todoItems.length > 0) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ approve"));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if ((executionMode || approvalState === "pending") && todoItems.length > 0) {
			const prefix = approvalState === "pending" && !executionMode ? [ctx.ui.theme.fg("warning", "Pending approval:")] : [];
			ctx.ui.setWidget(
				"plan-todos",
				[
					...prefix,
					...todoItems.map((item) => {
						if (item.completed) {
							return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
						}
						return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
					}),
				],
			);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function summarizeTodos(): string {
		if (todoItems.length === 0) return "No tracked plan steps.";
		return todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
	}

	function setPendingPlan(todos: TodoItem[], ctx?: ExtensionContext): void {
		todoItems = todos;
		approvalState = "pending";
		approvedPlanText = undefined;
		if (ctx) updateStatus(ctx);
		persistState();
	}

	function clearPlanState(): void {
		executionMode = false;
		approvalState = "none";
		todoItems = [];
		approvedPlanText = undefined;
	}

	function uniqueStepNumbers(values: Array<number | undefined>): number[] {
		return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value > 0))];
	}

	function setTodoCompletion(steps: number[], completed: boolean): number {
		let changed = 0;
		const stepSet = new Set(steps);
		for (const item of todoItems) {
			if (!stepSet.has(item.step) || item.completed === completed) continue;
			item.completed = completed;
			changed++;
		}
		return changed;
	}

	function completionSummary(): string {
		const completed = todoItems.filter((todo) => todo.completed).length;
		return `${completed}/${todoItems.length} complete`;
	}

	function parseStepList(input: string): number[] {
		if (input.trim() === "all") return todoItems.map((todo) => todo.step);
		return uniqueStepNumbers(input.split(/[\s,]+/).map((value) => Number(value)));
	}

	function markStepsFromCommand(ctx: ExtensionContext, input: string, completed: boolean): void {
		if (todoItems.length === 0) {
			ctx.ui.notify("No tracked plan steps to update.", "warning");
			return;
		}

		const steps = parseStepList(input);
		if (steps.length === 0) {
			ctx.ui.notify("Usage: /plan done <step|all> or /plan undone <step|all>", "warning");
			return;
		}

		const changed = setTodoCompletion(steps, completed);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(
			`${completed ? "Marked complete" : "Marked incomplete"}: ${steps.join(", ")} (${completionSummary()}).${changed === 0 ? " No visible changes." : ""}`,
			"info",
		);
	}

	pi.registerTool({
		name: PLAN_PROGRESS_TOOL,
		label: "Plan Progress",
		description: "Update the visible task list while executing a user-approved plan.",
		promptSnippet: "Mark approved plan steps complete or incomplete during plan execution",
		promptGuidelines: [
			"Use plan_progress while executing an approved plan to update the visible task list immediately after each step is truly complete.",
			"Do not call plan_progress before the step has actually been implemented and verified.",
		],
		parameters: Type.Object({
			action: StringEnum(PLAN_PROGRESS_ACTIONS),
			step: Type.Optional(Type.Integer({ description: "Single plan step number to update." })),
			steps: Type.Optional(Type.Array(Type.Integer(), { description: "Multiple plan step numbers to update." })),
			note: Type.Optional(Type.String({ description: "Optional short note about the progress update." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!executionMode || approvalState !== "approved" || todoItems.length === 0) {
				return {
					content: [{ type: "text", text: "No approved plan is currently executing; plan progress was not changed." }],
					details: { ignored: true, executing: executionMode, approvalState },
				};
			}

			let changed = 0;
			if (params.action === "reset") {
				changed = todoItems.filter((todo) => todo.completed).length;
				for (const item of todoItems) item.completed = false;
			} else if (params.action === "complete_all") {
				changed = todoItems.filter((todo) => !todo.completed).length;
				for (const item of todoItems) item.completed = true;
			} else {
				const requestedSteps = uniqueStepNumbers([params.step, ...(params.steps ?? [])]);
				if (requestedSteps.length === 0) {
					return {
						content: [{ type: "text", text: "No valid plan step number was provided; plan progress was not changed." }],
						details: { ignored: true, todos: todoItems },
					};
				}
				changed = setTodoCompletion(requestedSteps, params.action === "complete");
			}

			updateStatus(ctx);
			persistState();

			return {
				content: [
					{
						type: "text",
						text: `Plan progress updated (${completionSummary()}).${changed === 0 ? " No visible changes." : ""}`,
					},
				],
				details: { changed, todos: todoItems, note: params.note },
			};
		},
	});

	function enablePlanMode(ctx: ExtensionContext): void {
		if (!planModeEnabled && !executionMode) {
			toolsBeforePlan = pi.getActiveTools();
		}
		planModeEnabled = true;
		executionMode = false;
		approvalState = "none";
		todoItems = [];
		approvedPlanText = undefined;
		applyPlanTools(ctx);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Approval-gated plan mode enabled. Read-only tools: ${getPlanToolNames().join(", ")}`, "info");
	}

	function disablePlanMode(ctx: ExtensionContext, clearTodos = false): void {
		planModeEnabled = false;
		executionMode = false;
		approvalState = "none";
		approvedPlanText = undefined;
		if (clearTodos) todoItems = [];
		restoreTools();
		deactivateProgressTool();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
	}

	function beginApprovedExecution(ctx: ExtensionContext): void {
		if (approvalState !== "approved") {
			ctx.ui.notify("Cannot execute: no plan has been approved yet.", "warning");
			return;
		}

		planModeEnabled = false;
		executionMode = todoItems.length > 0;
		restoreTools();
		if (executionMode) activateProgressTool();
		updateStatus(ctx);
		persistState();

		const firstStep = todoItems.find((todo) => !todo.completed);
		const message = firstStep
			? `Execute the user-approved plan. Start with step ${firstStep.step}: ${firstStep.text}`
			: "Execute the user-approved plan.";

		pi.sendMessage(
			{
				customType: "plan-mode-execute",
				content: message,
				display: true,
				details: { approved: true, approvedPlanText, todos: todoItems },
			},
			{ triggerTurn: true },
		);
	}

	async function approveAndExecute(ctx: ExtensionContext): Promise<void> {
		if (todoItems.length === 0) {
			ctx.ui.notify("No pending plan to approve. Ask the agent to produce a numbered Plan: first.", "warning");
			return;
		}

		if (approvalState !== "pending" && approvalState !== "approved") {
			ctx.ui.notify("No pending plan to approve. Ask the agent to produce a numbered Plan: first.", "warning");
			return;
		}

		if (approvalState !== "approved") {
			approvedPlanText = formatPlan(todoItems);
			approvalState = "approved";
			pi.sendMessage(
				{
					customType: "plan-approved",
					content: `**Plan approved by user.**\n\n${approvedPlanText}`,
					display: true,
					details: { approved: true, approvedAt: Date.now(), todos: todoItems },
				},
				{ triggerTurn: false },
			);
		}

		beginApprovedExecution(ctx);
	}

	function rejectPendingPlan(ctx: ExtensionContext): void {
		if (approvalState !== "pending" || todoItems.length === 0) {
			ctx.ui.notify("No pending plan to reject.", "info");
			return;
		}

		const rejectedPlan = formatPlan(todoItems);
		approvalState = "none";
		todoItems = [];
		approvedPlanText = undefined;
		planModeEnabled = true;
		applyPlanTools(ctx);
		updateStatus(ctx);
		persistState();
		pi.sendMessage(
			{
				customType: "plan-rejected",
				content: `**Plan rejected by user.** Stay in read-only plan mode and produce a revised plan if needed.\n\nRejected plan:\n${rejectedPlan}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function showStatus(ctx: ExtensionContext): void {
		const mode = executionMode ? "executing approved plan" : planModeEnabled ? "planning/read-only" : "off";
		const activeTools = pi.getActiveTools().join(", ");
		ctx.ui.notify(
			`Plan mode: ${mode}\nApproval: ${approvalState}\nActive tools: ${activeTools}\n\n${summarizeTodos()}`,
			"info",
		);
	}

	pi.registerCommand("plan", {
		description: "Approval-gated plan mode. Args: on, off, approve, execute, done, undone, reject, status, clear",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "" || action === "toggle") {
				if (planModeEnabled) disablePlanMode(ctx);
				else enablePlanMode(ctx);
				return;
			}

			if (["on", "enable", "start"].includes(action)) {
				enablePlanMode(ctx);
				return;
			}

			if (["off", "disable", "stop"].includes(action)) {
				disablePlanMode(ctx);
				return;
			}

			if (["approve", "approved", "execute", "run"].includes(action)) {
				if (approvalState === "pending" && ctx.hasUI) {
					const ok = await ctx.ui.confirm("Approve and execute this plan?", formatPlan(todoItems));
					if (!ok) {
						ctx.ui.notify("Plan execution blocked: approval was not granted.", "warning");
						return;
					}
				}
				await approveAndExecute(ctx);
				return;
			}

			const [verb, ...stepArgs] = action.split(/\s+/);
			if (["done", "complete"].includes(verb)) {
				markStepsFromCommand(ctx, stepArgs.join(" "), true);
				return;
			}

			if (["undone", "incomplete", "uncomplete"].includes(verb)) {
				markStepsFromCommand(ctx, stepArgs.join(" "), false);
				return;
			}

			if (action === "reject") {
				rejectPendingPlan(ctx);
				return;
			}

			if (action === "status") {
				showStatus(ctx);
				return;
			}

			if (action === "clear") {
				clearPlanState();
				deactivateProgressTool();
				updateStatus(ctx);
				persistState();
				ctx.ui.notify("Cleared tracked plan steps and approval state.", "info");
				return;
			}

			ctx.ui.notify("Usage: /plan [on|off|approve|execute|done <step|all>|undone <step|all>|reject|status|clear]", "warning");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => showStatus(ctx),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle approval-gated plan mode",
		handler: async (ctx) => {
			if (planModeEnabled) disablePlanMode(ctx);
			else enablePlanMode(ctx);
		},
	});

	pi.on("tool_call", async (event) => {
		const gateActive = planModeEnabled || approvalState === "pending" || (executionMode && approvalState !== "approved");
		if (!gateActive) return;

		if (!isReadOnlyToolName(event.toolName)) {
			return {
				block: true,
				reason: `Approval-gated plan mode: '${event.toolName}' is blocked until the user explicitly approves a plan.`,
			};
		}

		if (event.toolName !== "bash") return;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Approval-gated plan mode blocked a non-allowlisted bash command until plan approval.\nCommand: ${command}`,
			};
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (planModeEnabled) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n[APPROVAL-GATED PLAN MODE ACTIVE]\nYou are in read-only plan mode. Explore the codebase safely and produce a plan; do not modify files.\n\nHard gate:\n- You cannot execute or modify files until the user explicitly approves a numbered plan.\n- Do not claim approval unless this prompt says you are executing an approved plan.\n- If the user asks you to implement while this gate is active, produce or refine the plan instead.\n\nRestrictions before approval:\n- Use only the active read-only tools: ${pi.getActiveTools().join(", ")}\n- Do not use edit/write or any mutating command.\n- Bash is allowed only for read-only inspection commands.\n\nRequired output when ready for approval:\nPlan:\n1. First concrete implementation step\n2. Second concrete implementation step\n...\n\nKeep the plan actionable and mention any risks or open questions after the numbered list.`,
			};
		}

		if (executionMode && todoItems.length > 0 && approvalState === "approved") {
			const remaining = todoItems.filter((todo) => !todo.completed).map((todo) => `${todo.step}. ${todo.text}`).join("\n");
			return {
				systemPrompt: `${event.systemPrompt}\n\n[EXECUTING USER-APPROVED PLAN]\nThe user explicitly approved this plan. Full tool access has been restored. Execute the remaining steps in order and do not expand scope beyond the approved plan without asking.\n\nApproved plan:\n${approvedPlanText ?? formatPlan(todoItems)}\n\nRemaining steps:\n${remaining}\n\nProgress tracking:\n- After fully completing and verifying step n, call the plan_progress tool with action \"complete\" and step n so the visible task list updates immediately.\n- Do not mark a step complete before it is actually done.\n- [DONE:n] text markers are only a fallback if plan_progress is unavailable.`,
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || approvalState !== "approved" || todoItems.length === 0 || !isAssistantMessage(event.message)) return;

		const changed = markCompletedSteps(getTextContent(event.message), todoItems);
		if (changed > 0) updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && approvalState === "approved" && todoItems.length > 0) {
			if (todoItems.every((todo) => todo.completed)) {
				const completedList = todoItems.map((todo) => `✓ ${todo.text}`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Approved plan complete!**\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				clearPlanState();
				deactivateProgressTool();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				setPendingPlan(extracted, ctx);
			}
		}

		if (!ctx.hasUI) return;

		if (approvalState !== "pending" || todoItems.length === 0) {
			persistState();
			return;
		}

		const todoListText = formatPlan(todoItems);
		pi.sendMessage(
			{
				customType: "plan-approval-required",
				content: `**Plan requires approval before execution.**\n\n${todoListText}`,
				display: true,
				details: { approvalState, todos: todoItems },
			},
			{ triggerTurn: false },
		);

		const choice = await ctx.ui.select("Plan approval required", [
			"Approve and execute plan",
			"Request revisions",
			"Reject plan",
			"Stay in read-only plan mode",
			"Disable plan mode",
		]);

		if (choice === "Approve and execute plan") {
			await approveAndExecute(ctx);
		} else if (choice === "Request revisions") {
			const refinement = await ctx.ui.editor("Request plan revisions:", "Revise the plan to address: ");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		} else if (choice === "Reject plan") {
			rejectPendingPlan(ctx);
		} else if (choice === "Disable plan mode") {
			disablePlanMode(ctx);
		} else {
			persistState();
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = [...entries]
			.reverse()
			.find((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "plan-mode") as
			| { data?: PlanState }
			| undefined;

		if (stateEntry?.data) {
			planModeEnabled = stateEntry.data.enabled ?? planModeEnabled;
			executionMode = stateEntry.data.executing ?? executionMode;
			approvalState = stateEntry.data.approvalState ?? approvalState;
			todoItems = stateEntry.data.todos ?? todoItems;
			approvedPlanText = stateEntry.data.approvedPlanText;
			toolsBeforePlan = stateEntry.data.toolsBeforePlan;
		}

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
			executionMode = false;
			approvalState = "none";
			approvedPlanText = undefined;
		}

		if (planModeEnabled && (!toolsBeforePlan || toolsBeforePlan.length === 0)) {
			toolsBeforePlan = pi.getActiveTools();
		}

		if (executionMode && approvalState === "approved" && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const textSinceExecution = entries
				.slice(executeIndex + 1)
				.flatMap((entry) => {
					if (entry.type !== "message" || !("message" in entry) || !isAssistantMessage(entry.message as AgentMessage)) {
						return [];
					}
					return [getTextContent(entry.message as AssistantMessage)];
				})
				.join("\n");
			markCompletedSteps(textSinceExecution, todoItems);
		}

		if (planModeEnabled) {
			applyPlanTools(ctx);
		} else if (executionMode && approvalState === "approved" && todoItems.length > 0) {
			activateProgressTool();
		} else {
			deactivateProgressTool();
		}
		updateStatus(ctx);
	});
}
