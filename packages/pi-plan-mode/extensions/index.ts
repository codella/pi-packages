/**
 * Plan Mode Extension
 *
 * True approval-gated plan mode for pi.
 *
 * Commands:
 * - /plan              toggle plan mode
 * - /plan on|off       explicitly enable/disable
 *
 * Shortcut:
 * - Ctrl+Alt+P         toggle plan mode
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
const PLAN_PROGRESS_ACTIONS = ["complete", "uncomplete"] as const;

type ApprovalState = "none" | "pending" | "approved";

type PlanState = {
	enabled?: boolean;
	executing?: boolean;
	approvalState?: ApprovalState;
	todos?: TodoItem[];
	approvedPlanText?: string;
	toolsBeforePlan?: string[];
};

type PlanMessage = {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
};

type SendMessageOptions = {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
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

type PlanCustomMessage = {
	content?: string;
};

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

function renderPlanMessageContent(content: string, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(16, width);
	const lines: string[] = [];

	for (const rawLine of content.split(/\r?\n/)) {
		const plainLine = stripInlineMarkdown(rawLine).trim();
		if (plainLine.length === 0) {
			if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
			continue;
		}

		const numberedMatch = plainLine.match(/^(\d+)[.)]\s+(.+)$/);
		if (numberedMatch) {
			const prefix = `${numberedMatch[1]}. `;
			const textWidth = Math.max(1, safeWidth - prefix.length);
			const wrapped = wrapPlain(numberedMatch[2] ?? "", textWidth, 1000);
			for (let index = 0; index < wrapped.length; index++) {
				const text = wrapped[index] ?? "";
				const linePrefix = index === 0 ? prefix : " ".repeat(prefix.length);
				lines.push(`${theme.fg("accent", linePrefix)}${theme.fg("text", text)}`);
			}
			continue;
		}

		const style = plainLine.startsWith("Plan approved")
			? "success"
			: plainLine.startsWith("Plan rejected") || plainLine.startsWith("Plan requires")
				? "warning"
				: plainLine.endsWith("plan:")
					? "muted"
					: "text";

		for (const line of wrapPlain(plainLine, safeWidth, 1000)) {
			lines.push(theme.fg(style, line));
		}
	}

	return lines.length > 0 ? lines : [theme.fg("dim", "plan mode")];
}

function renderPlanModeMessage(message: PlanCustomMessage, _options: unknown, theme: Theme) {
	return {
		render(width: number): string[] {
			return renderPlanMessageContent(message.content ?? "", theme, width);
		},
		invalidate(): void {},
	};
}

type PlanWidgetMode = "pending" | "executing";

type StyledSegment = {
	text: string;
	width: number;
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function truncatePlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function appendEllipsis(text: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "…";
	if (text.length >= width) return `${text.slice(0, width - 1)}…`;
	return `${text}…`;
}

function wrapPlain(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];

	let remaining = text.replace(/\s+/g, " ").trim();
	if (remaining.length === 0) return [""];

	const lines: string[] = [];
	while (remaining.length > width && lines.length < maxLines) {
		let splitAt = remaining.lastIndexOf(" ", width + 1);
		if (splitAt <= 0) splitAt = width;

		lines.push(remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
	}

	if (lines.length < maxLines) lines.push(remaining);
	else if (remaining.length > 0) lines[lines.length - 1] = appendEllipsis(lines[lines.length - 1] ?? "", width);

	return lines;
}

function segment(text: string, width?: number): StyledSegment {
	return { text, width: width ?? text.length };
}

function renderPlanTodoWidget(theme: Theme, width: number, mode: PlanWidgetMode, todos: TodoItem[]): string[] {
	const total = todos.length;
	const completed = todos.filter((todo) => todo.completed).length;
	const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
	const accent = mode === "pending" ? "warning" : "accent";
	const title = mode === "pending" ? " PLAN REVIEW " : " PLAN TRACKER ";

	if (width < 24) {
		const label = mode === "pending" ? `${total} steps pending` : `${completed}/${total} done`;
		return [theme.fg(accent, theme.bold(truncatePlain(label, width)))];
	}

	const rowWidth = Math.max(24, width);
	const contentWidth = rowWidth - 4;
	const border = (value: string): string => theme.fg("borderMuted", value);
	const row = (parts: StyledSegment[]): string => {
		const used = parts.reduce((sum, part) => sum + part.width, 0);
		return `${border("│ ")}${parts.map((part) => part.text).join("")}${" ".repeat(Math.max(0, contentWidth - used))}${border(" │")}`;
	};
	const fullRow = (plain: string, styled = plain): string => row([segment(styled, plain.length)]);

	const clippedTitle = truncatePlain(title, rowWidth - 2);
	const topFill = "─".repeat(Math.max(0, rowWidth - 2 - clippedTitle.length));
	const lines = [`${border("╭")}${theme.fg(accent, theme.bold(clippedTitle))}${border(`${topFill}╮`)}`];

	if (mode === "pending") {
		const summary = truncatePlain(`${total} proposed steps • approval required before tools unlock`, contentWidth);
		lines.push(fullRow(summary, theme.fg("warning", summary)));
	} else {
		const label = truncatePlain(`${completed}/${total} complete • ${percent}%`, Math.max(8, Math.floor(contentWidth * 0.42)));
		const barWidth = clamp(contentWidth - label.length - 1, 6, 28);
		const filled = total > 0 ? Math.round((barWidth * completed) / total) : 0;
		const bar = theme.fg("success", "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(barWidth - filled));
		lines.push(
			row([
				segment(bar, barWidth),
				segment(" "),
				segment(theme.fg(completed === total ? "success" : "muted", label), label.length),
			]),
		);
	}

	lines.push(`${border("├")}${border("─".repeat(rowWidth - 2))}${border("┤")}`);

	const stepDigits = Math.max(2, String(total).length);
	const nextOpenStep = todos.find((todo) => !todo.completed)?.step;
	for (const item of todos) {
		const active = mode === "executing" && item.step === nextOpenStep;
		const marker = item.completed ? "✓" : active ? "▶" : "○";
		const markerStyle = item.completed ? "success" : active ? "accent" : mode === "pending" ? "warning" : "dim";
		const step = `#${String(item.step).padStart(stepDigits, "0")}`;
		const prefixWidth = marker.length + 1 + step.length + 1;
		const textWidth = Math.max(0, contentWidth - prefixWidth);
		const wrappedText = wrapPlain(item.text, textWidth, Number.POSITIVE_INFINITY);

		const styleItemText = (text: string): string =>
			item.completed
				? theme.fg("muted", theme.strikethrough(text))
				: active
					? theme.fg("accent", theme.bold(text))
					: theme.fg(mode === "pending" ? "text" : "muted", text);

		for (let lineIndex = 0; lineIndex < wrappedText.length; lineIndex++) {
			const text = wrappedText[lineIndex] ?? "";
			if (lineIndex === 0) {
				lines.push(
					row([
						segment(theme.fg(markerStyle, marker), marker.length),
						segment(" "),
						segment(theme.fg(item.completed ? "muted" : "accent", step), step.length),
						segment(" "),
						segment(styleItemText(text), text.length),
					]),
				);
			} else {
				lines.push(
					row([segment(" ".repeat(prefixWidth), prefixWidth), segment(styleItemText(text), text.length)]),
				);
			}
		}
	}

	const footer = truncatePlain(
		mode === "pending" ? "approve • chat more • reject" : nextOpenStep ? `next up: step ${nextOpenStep}` : "all steps complete",
		contentWidth,
	);
	lines.push(`${border("├")}${border("─".repeat(rowWidth - 2))}${border("┤")}`);
	lines.push(fullRow(footer, theme.fg("dim", footer)));
	lines.push(`${border("╰")}${border("─".repeat(rowWidth - 2))}${border("╯")}`);

	return lines;
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

	for (const customType of ["plan-approval-required", "plan-approved", "plan-rejected"]) {
		pi.registerMessageRenderer(customType, renderPlanModeMessage);
	}

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

		const hasTodoItems = todoItems.length > 0;
		const executionHasOpenSteps = executionMode && hasTodoItems && todoItems.some((todo) => !todo.completed);
		const reviewPending = approvalState === "pending" && hasTodoItems;

		if (executionMode && hasTodoItems) {
			ctx.ui.setStatus("plan-mode", undefined);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "planning"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionHasOpenSteps || reviewPending) {
			const widgetMode: PlanWidgetMode = executionHasOpenSteps ? "executing" : "pending";
			ctx.ui.setWidget("plan-todos", (_tui: unknown, theme: Theme) => ({
				render(width: number): string[] {
					return renderPlanTodoWidget(theme, width, widgetMode, todoItems);
				},
				invalidate(): void {},
			}));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
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

	function finishApprovedPlan(ctx: ExtensionContext): TodoItem[] {
		const completedTodos = todoItems.map((todo) => ({ ...todo }));
		clearPlanState();
		deactivateProgressTool();
		updateStatus(ctx);
		persistState();
		pi.appendEntry("plan-mode-complete", { completedAt: Date.now(), todos: completedTodos });
		if (ctx.hasUI) ctx.ui.notify(`Approved plan complete (${completedTodos.length} steps).`, "info");
		return completedTodos;
	}

	function waitUntilIdle(ctx: ExtensionContext): Promise<void> {
		if (ctx.isIdle()) return Promise.resolve();

		return new Promise((resolve) => {
			const poll = () => {
				if (ctx.isIdle()) {
					resolve();
					return;
				}
				setTimeout(poll, 25);
			};
			setTimeout(poll, 0);
		});
	}

	let idleMessageQueue: Promise<void> = Promise.resolve();

	function sendMessageWhenIdle(
		ctx: ExtensionContext,
		message: PlanMessage,
		options?: SendMessageOptions,
		shouldSend: () => boolean = () => true,
	): void {
		const deliver = async () => {
			await waitUntilIdle(ctx);
			if (!shouldSend()) return;
			pi.sendMessage(message, options);
		};

		idleMessageQueue = idleMessageQueue.then(deliver, deliver).catch((error) => {
			const reason = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Plan mode failed to send a queued message: ${reason}`, "error");
		});
	}

	pi.registerTool({
		name: PLAN_PROGRESS_TOOL,
		label: "Plan Progress",
		description: "Update the visible task list while executing a user-approved plan.",
		promptSnippet: "Mark approved plan steps complete or incomplete during plan execution",
		promptGuidelines: [
			"Use plan_progress while executing an approved plan to update the visible task list immediately after each step is truly complete.",
			"Update exactly one step per plan_progress call; never batch multiple completed steps into one update.",
			"Do not call plan_progress before the step has actually been implemented and verified.",
			"plan_progress updates UI silently; do not narrate or quote its result to the user.",
			"When the final approved plan step is complete, call plan_progress as the last tool call and then stop without running extra tools.",
		],
		parameters: Type.Object({
			action: StringEnum(PLAN_PROGRESS_ACTIONS),
			step: Type.Integer({ description: "The single plan step number to update." }),
			note: Type.Optional(Type.String({ description: "Optional short note about the progress update." })),
		}),
		renderCall() {
			return {
				render(): string[] {
					return [];
				},
				invalidate(): void {},
			};
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((block) => block.type === "text")?.text?.trim() ?? "";
			const ignored =
				typeof result.details === "object" && result.details !== null && "ignored" in result.details;

			return {
				render(width: number): string[] {
					if (!ignored || text.length === 0) return [];
					return [theme.fg("warning", truncatePlain(text, width))];
				},
				invalidate(): void {},
			};
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!executionMode || approvalState !== "approved" || todoItems.length === 0) {
				return {
					content: [{ type: "text", text: "No approved plan is currently executing; plan progress was not changed." }],
					details: { ignored: true, executing: executionMode, approvalState },
				};
			}

			const requestedSteps = uniqueStepNumbers([params.step]);
			if (requestedSteps.length !== 1) {
				return {
					content: [{ type: "text", text: "Exactly one valid plan step number is required; plan progress was not changed." }],
					details: { ignored: true, todos: todoItems.map((todo) => ({ ...todo })) },
				};
			}

			const changed = setTodoCompletion(requestedSteps, params.action === "complete");

			const allComplete = todoItems.length > 0 && todoItems.every((todo) => todo.completed);
			const summary = completionSummary();
			const todos = allComplete ? finishApprovedPlan(ctx) : todoItems.map((todo) => ({ ...todo }));
			if (!allComplete) {
				updateStatus(ctx);
				persistState();
			}

			return {
				content: [{ type: "text", text: "" }],
				details: { changed, summary, todos, note: params.note, allComplete },
				terminate: allComplete,
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

		sendMessageWhenIdle(
			ctx,
			{
				customType: "plan-mode-execute",
				content: message,
				display: true,
				details: { approved: true, approvedPlanText, todos: todoItems.map((todo) => ({ ...todo })) },
			},
			{ triggerTurn: true },
			() => executionMode && approvalState === "approved",
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
			sendMessageWhenIdle(
				ctx,
				{
					customType: "plan-approved",
					content: `**Plan approved by user.**\n\n${approvedPlanText}`,
					display: true,
					details: { approved: true, approvedAt: Date.now(), todos: todoItems.map((todo) => ({ ...todo })) },
				},
				{ triggerTurn: false },
				() => approvalState === "approved",
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
		sendMessageWhenIdle(
			ctx,
			{
				customType: "plan-rejected",
				content: `**Plan rejected by user.** Read-only plan mode remains active if you want to discuss a new approach.\n\nRejected plan:\n${rejectedPlan}`,
				display: true,
			},
			{ triggerTurn: false },
			() => approvalState === "none" && planModeEnabled,
		);
	}

	pi.registerCommand("plan", {
		description: "Toggle approval-gated plan mode. Args: on, off",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "") {
				if (planModeEnabled) disablePlanMode(ctx);
				else enablePlanMode(ctx);
				return;
			}

			if (action === "on") {
				enablePlanMode(ctx);
				return;
			}

			if (action === "off") {
				disablePlanMode(ctx);
				return;
			}

			ctx.ui.notify("Usage: /plan [on|off]", "warning");
		},
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
				systemPrompt: `${event.systemPrompt}\n\n[EXECUTING USER-APPROVED PLAN]\nThe user explicitly approved this plan. Full tool access has been restored. Execute the remaining steps in order and do not expand scope beyond the approved plan without asking.\n\nApproved plan:\n${approvedPlanText ?? formatPlan(todoItems)}\n\nRemaining steps:\n${remaining}\n\nProgress tracking:\n- After fully completing and verifying step n, call the plan_progress tool with action \"complete\" and step n so the visible task list updates immediately.\n- Call plan_progress for exactly one completed step at a time, before starting the next plan step.\n- Do not batch multiple steps into one progress update.\n- Do not mark a step complete before it is actually done.\n- After marking the final step complete, stop immediately; do not call any more tools or run extra checks.`,
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || approvalState !== "approved" || todoItems.length === 0 || !isAssistantMessage(event.message)) return;

		if (pi.getActiveTools().includes(PLAN_PROGRESS_TOOL)) {
			persistState();
			return;
		}

		const changed = markCompletedSteps(getTextContent(event.message), todoItems);
		if (changed > 0) updateStatus(ctx);
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && approvalState === "approved" && todoItems.length > 0) {
			if (todoItems.every((todo) => todo.completed)) {
				finishApprovedPlan(ctx);
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
		sendMessageWhenIdle(
			ctx,
			{
				customType: "plan-approval-required",
				content: `**Plan requires approval before execution.**\n\n${todoListText}`,
				display: true,
				details: { approvalState, todos: todoItems.map((todo) => ({ ...todo })) },
			},
			{ triggerTurn: false },
			() => planModeEnabled && approvalState === "pending" && todoItems.length > 0,
		);

		const choice = await ctx.ui.select("Plan approval required", ["Approve", "Let's chat more about it", "Reject"]);

		if (choice === "Approve") {
			await approveAndExecute(ctx);
		} else if (choice === "Reject") {
			rejectPendingPlan(ctx);
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

		if (executionMode && approvalState === "approved" && todoItems.length > 0 && !availableToolNames().has(PLAN_PROGRESS_TOOL)) {
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
