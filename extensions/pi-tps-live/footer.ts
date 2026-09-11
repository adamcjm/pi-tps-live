/**
 * pi-tps-live — footer rendering.
 *
 * Reproduces pi's built-in footer layout (based on pi 0.85.x
 * `dist/modes/interactive/components/footer.js`) and adds one element: a
 * right-aligned tok/s readout at the end of the **first** line.
 *
 * Framework-free: the `visibleWidth` / `truncateToWidth` helpers and the
 * theme are injected, so this module can be unit-tested with stubs.
 */

/** Minimal theme surface used for coloring. */
export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** Minimal pi-tui surface used for layout. */
export interface TuiLike {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

/** Speed text + whether it describes live streaming. */
export interface SpeedDisplay {
	text: string;
	live: boolean;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface SessionEntryLike {
	type: string;
	message?: {
		role?: string;
		usage?: UsageLike;
	};
	usage?: UsageLike;
}

/** Everything `renderFooterLines` needs, already resolved by `register.ts`. */
export interface FooterData {
	cwd: string;
	home: string | undefined;
	branch: string | null;
	sessionName: string | undefined;
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextPercent: number | null;
	contextWindow: number;
	autoCompactEnabled: boolean;
	modelId: string | undefined;
	modelProvider: string | undefined;
	modelReasoning: boolean;
	thinkingLevel: string | undefined;
	providerCount: number;
	usingSubscription: boolean;
	statuses: ReadonlyMap<string, string>;
	speed: SpeedDisplay | undefined;
}

/** Minimum columns reserved for the left side of line 1 before the speed text is dropped. */
const MIN_PWD_WIDTH = 12;

/** Format token counts for the compact footer (same buckets as pi's built-in footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Replace the home prefix with `~` when the cwd is inside it. */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const sep = "/";
	const resolvedCwd = cwd.replace(/\/+$/, "");
	const resolvedHome = home.replace(/\/+$/, "");
	if (resolvedCwd === resolvedHome) return "~";
	if (resolvedCwd.startsWith(`${resolvedHome}${sep}`)) return `~${resolvedCwd.slice(resolvedHome.length)}`;
	return cwd;
}

/** Collapse control characters so extension statuses stay single-line. */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format a reading for display, e.g. `42.3 tok/s` / `~42.3 tok/s`. */
export function formatSpeedText(reading: { tps: number; estimated: boolean }): string {
	const value = reading.tps >= 100 ? reading.tps.toFixed(0) : reading.tps.toFixed(1);
	return `${reading.estimated ? "~" : ""}${value} tok/s`;
}

/**
 * Sum session usage the same way the built-in footer does: assistant
 * messages, tool-result usage and branch/compaction summary usage.
 */
export function collectUsageTotals(entries: Iterable<SessionEntryLike>): {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
} {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of entries) {
		let usage: UsageLike | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant") usage = entry.message.usage;
		else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage)
			usage = entry.message.usage;
		else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) usage = entry.usage;
		if (!usage) continue;

		const input = usage.input ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		totals.input += input;
		totals.output += usage.output ?? 0;
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.cost += usage.cost?.total ?? 0;

		if (entry.type === "message" && entry.message?.role === "assistant") {
			const promptTokens = input + cacheRead + cacheWrite;
			latestCacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
		}
	}
	return { totals, latestCacheHitRate };
}

/**
 * Build the footer lines.
 *
 * Line 1: `pwd (branch) • session` on the left, tok/s right-aligned.
 * Line 2: token/cache/cost/context stats on the left, model on the right.
 * Line 3+: extension statuses (from `ctx.ui.setStatus`).
 */
export function renderFooterLines(data: FooterData, width: number, theme: ThemeLike, tui: TuiLike): string[] {
	// --- first line: pwd + session name, with the speed readout on the right ---
	let pwd = formatCwdForFooter(data.cwd, data.home);
	if (data.branch) pwd = `${pwd} (${data.branch})`;
	if (data.sessionName) pwd = `${pwd} • ${data.sessionName}`;
	const pwdText = theme.fg("dim", pwd);

	let line1 = tui.truncateToWidth(pwdText, width, theme.fg("dim", "..."));
	if (data.speed) {
		const speedText = theme.fg(data.speed.live ? "accent" : "dim", `⚡ ${data.speed.text}`);
		const speedWidth = tui.visibleWidth(speedText);
		if (MIN_PWD_WIDTH + speedWidth <= width) {
			const left = tui.truncateToWidth(pwdText, width - speedWidth - 1, theme.fg("dim", "..."));
			const gap = Math.max(1, width - tui.visibleWidth(left) - speedWidth);
			line1 = left + " ".repeat(gap) + speedText;
		}
	}

	// --- second line: stats left, model right ---
	const statsParts: string[] = [];
	if (data.totals.input) statsParts.push(`↑${formatTokens(data.totals.input)}`);
	if (data.totals.output) statsParts.push(`↓${formatTokens(data.totals.output)}`);
	if (data.totals.cacheRead) statsParts.push(`R${formatTokens(data.totals.cacheRead)}`);
	if (data.totals.cacheWrite) statsParts.push(`W${formatTokens(data.totals.cacheWrite)}`);
	if ((data.totals.cacheRead > 0 || data.totals.cacheWrite > 0) && data.latestCacheHitRate !== undefined) {
		statsParts.push(`CH${data.latestCacheHitRate.toFixed(1)}%`);
	}
	if (data.totals.cost > 0 || data.usingSubscription) {
		statsParts.push(`$${data.totals.cost.toFixed(3)}${data.usingSubscription ? " (sub)" : ""}`);
	}

	const contextPercentValue = data.contextPercent ?? 0;
	const autoIndicator = data.autoCompactEnabled ? " (auto)" : "";
	const contextDisplay =
		data.contextPercent === null
			? `?/${formatTokens(data.contextWindow)}${autoIndicator}`
			: `${contextPercentValue.toFixed(1)}%/${formatTokens(data.contextWindow)}${autoIndicator}`;
	const contextStr =
		contextPercentValue > 90
			? theme.fg("error", contextDisplay)
			: contextPercentValue > 70
				? theme.fg("warning", contextDisplay)
				: contextDisplay;
	statsParts.push(contextStr);

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = tui.visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = tui.truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = tui.visibleWidth(statsLeft);
	}

	let modelSide = data.modelId ?? "no-model";
	if (data.modelReasoning) {
		const level = data.thinkingLevel || "off";
		modelSide = level === "off" ? `${modelSide} • thinking off` : `${modelSide} • ${level}`;
	}
	if (data.providerCount > 1 && data.modelProvider) {
		const withProvider = `(${data.modelProvider}) ${modelSide}`;
		if (statsLeftWidth + 2 + tui.visibleWidth(withProvider) <= width) modelSide = withProvider;
	}

	const rightWidth = tui.visibleWidth(modelSide);
	const minPadding = 2;
	let statsLine: string;
	if (statsLeftWidth + minPadding + rightWidth <= width) {
		statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + modelSide;
	} else {
		const availableForRight = width - statsLeftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = tui.truncateToWidth(modelSide, availableForRight, "");
			const truncatedWidth = tui.visibleWidth(truncatedRight);
			statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - truncatedWidth)) + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	// Dim both halves separately: statsLeft may contain color codes (context
	// percentage) that end with a reset, which would clear an outer dim wrapper.
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	const line2 = dimStatsLeft + theme.fg("dim", remainder);

	const lines = [line1, line2];

	const statuses = Array.from(data.statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0);
	if (statuses.length > 0) {
		lines.push(tui.truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
	}
	return lines;
}
