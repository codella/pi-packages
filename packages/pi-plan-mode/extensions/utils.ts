/**
 * Pure utility functions for the plan-mode extension.
 */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

const REDIRECTION_PATTERN = /(^|[^<])>(?!&?\d)/;

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\binstall\b/i,
	/>>/,
	REDIRECTION_PATTERN,
	/\bsed\s+.*\s-i\b/i,
	/\bperl\s+.*\s-pi\b/i,
	/\bxargs\b/i,
	/\bcurl\b.*\s(-o|-O|--output|--remote-name)\b/i,
	/\bwget\b(?!(?:\s+[^;&|]*)?\s-O\s*-\b)/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|run|exec|x)\b/i,
	/\byarn\s+(add|remove|install|publish|run|exec|dlx)\b/i,
	/\bpnpm\s+(add|remove|install|publish|run|exec|dlx)\b/i,
	/\bbun\s+(add|remove|install|run|x)\b/i,
	/\bpip(?:3)?\s+(install|uninstall)\b/i,
	/\bcargo\s+(build|run|test|check|clippy|fix|install|publish|update)\b/i,
	/\bapt(?:-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade|update)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_SEGMENT_PATTERNS = [
	/^\s*(?:time\s+)?cat\b/i,
	/^\s*(?:time\s+)?head\b/i,
	/^\s*(?:time\s+)?tail\b/i,
	/^\s*(?:time\s+)?less\b/i,
	/^\s*(?:time\s+)?more\b/i,
	/^\s*(?:time\s+)?grep\b/i,
	/^\s*(?:time\s+)?rg\b/i,
	/^\s*(?:time\s+)?find\b/i,
	/^\s*(?:time\s+)?fd\b/i,
	/^\s*(?:time\s+)?ls\b/i,
	/^\s*(?:time\s+)?pwd\b/i,
	/^\s*(?:time\s+)?tree\b/i,
	/^\s*(?:time\s+)?echo\b/i,
	/^\s*(?:time\s+)?printf\b/i,
	/^\s*(?:time\s+)?wc\b/i,
	/^\s*(?:time\s+)?sort\b/i,
	/^\s*(?:time\s+)?uniq\b/i,
	/^\s*(?:time\s+)?diff\b/i,
	/^\s*(?:time\s+)?file\b/i,
	/^\s*(?:time\s+)?stat\b/i,
	/^\s*(?:time\s+)?du\b/i,
	/^\s*(?:time\s+)?df\b/i,
	/^\s*(?:time\s+)?which\b/i,
	/^\s*(?:time\s+)?whereis\b/i,
	/^\s*(?:time\s+)?type\b/i,
	/^\s*(?:time\s+)?env\s*$/i,
	/^\s*(?:time\s+)?printenv\b/i,
	/^\s*(?:time\s+)?uname\b/i,
	/^\s*(?:time\s+)?whoami\b/i,
	/^\s*(?:time\s+)?id\b/i,
	/^\s*(?:time\s+)?date\b/i,
	/^\s*(?:time\s+)?uptime\b/i,
	/^\s*(?:time\s+)?ps\b/i,
	/^\s*(?:time\s+)?jq\b/i,
	/^\s*(?:time\s+)?sed\s+-n\b/i,
	/^\s*(?:time\s+)?awk\b/i,
	/^\s*(?:time\s+)?git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|grep|blame)\b/i,
	/^\s*(?:time\s+)?npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(?:time\s+)?yarn\s+(list|info|why|audit)\b/i,
	/^\s*(?:time\s+)?pnpm\s+(list|info|outdated|audit)\b/i,
	/^\s*(?:time\s+)?node\s+(--version|-v)\b/i,
	/^\s*(?:time\s+)?python(?:3)?\s+(--version|-V)\b/i,
	/^\s*(?:time\s+)?rustc\s+(--version|-V)\b/i,
	/^\s*(?:time\s+)?cargo\s+(--version|-V|metadata|tree)\b/i,
	/^\s*(?:time\s+)?curl\b/i,
	/^\s*(?:time\s+)?wget\s+[^;&|]*\s-O\s*-\b/i,
	/^\s*(?:time\s+)?bat\b/i,
	/^\s*(?:time\s+)?eza\b/i,
];

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	const push = () => {
		const segment = current.trim();
		if (segment.length > 0) segments.push(segment);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}

		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}

		if (char === "\n" || char === ";") {
			push();
			continue;
		}

		if (char === "&" && next === "&") {
			push();
			i++;
			continue;
		}

		if (char === "|") {
			push();
			if (next === "|") i++;
			continue;
		}

		current += char;
	}

	push();
	return segments;
}

function stripLeadingAssignments(segment: string): string {
	return segment.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, "");
}

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

	const segments = splitShellSegments(trimmed);
	if (segments.length === 0) return false;

	return segments.every((segment) => {
		const normalized = stripLeadingAssignments(segment);
		return SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
	});
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\[[ x-]\]\s*/i, "")
		.replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
		.replace(/\s+/g, " ")
		.replace(/\s+([:;,.])/g, "$1")
		.trim();

	cleaned = cleaned.replace(/[:;]+$/g, "").trimEnd();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

function cleanContinuationText(text: string): string {
	return text
		.replace(/^\[[ x-]\]\s*/i, "")
		.replace(/\s+\[[^\]]+\]\s*$/g, "")
		.replace(/\*{1,2}$/g, "")
		.trim();
}

function appendContinuation(base: string, continuation: string): string {
	const cleanedContinuation = cleanContinuationText(continuation);
	if (cleanedContinuation.length === 0 || cleanedContinuation.startsWith("`") || cleanedContinuation.startsWith("/")) return base;

	const separator = /[:;]$/.test(base.trim()) ? " " : "; ";
	return `${base.trimEnd()}${separator}${cleanedContinuation}`;
}

export function extractTodoItems(message: string): TodoItem[] {
	const lines = message.split(/\r?\n/);
	const planHeaderIndex = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?(?:\*\*)?Plan(?:\*\*)?:?\s*$/i.test(line));
	if (planHeaderIndex === -1) return [];

	const rawItems: string[] = [];
	for (const line of lines.slice(planHeaderIndex + 1)) {
		if (rawItems.length > 0 && /^\s*#{1,6}\s+/.test(line)) break;
		if (rawItems.length > 0 && /^\s*(?:Notes?|Risks?|Questions?|Implementation)\s*:?\s*$/i.test(line)) break;

		const numberedMatch = line.match(/^\s*(?:[-*]\s*)?(\d+)[.)]\s+(.+)$/);
		if (numberedMatch) {
			const rawText = cleanContinuationText(numberedMatch[2]);
			if (rawText.length > 5 && !rawText.startsWith("`") && !rawText.startsWith("/")) rawItems.push(rawText);
			continue;
		}

		if (rawItems.length === 0) continue;

		const nestedBulletMatch = line.match(/^\s{2,}(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
		if (nestedBulletMatch) {
			rawItems[rawItems.length - 1] = appendContinuation(rawItems[rawItems.length - 1] ?? "", nestedBulletMatch[1]);
			continue;
		}

		const indentedContinuationMatch = line.match(/^\s{2,}(\S.+)$/);
		if (indentedContinuationMatch) {
			rawItems[rawItems.length - 1] = appendContinuation(rawItems[rawItems.length - 1] ?? "", indentedContinuationMatch[1]);
		}
	}

	return rawItems
		.map((rawText, index) => ({ step: index + 1, text: cleanStepText(rawText), completed: false }))
		.filter((item) => item.text.length > 3);
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return [...new Set(steps)];
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let changed = 0;
	for (const step of extractDoneSteps(text)) {
		const item = items.find((todo) => todo.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed++;
		}
	}
	return changed;
}
