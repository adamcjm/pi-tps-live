/**
 * pi-tps-live — extension wiring.
 *
 * Listens to assistant streaming events, feeds the `TpsMeter`, and replaces
 * pi's built-in footer with a copy that carries a right-aligned tok/s readout
 * at the end of the first line.
 *
 * Kept separately from `index.ts` so the wiring can be unit-tested with a
 * fake `ExtensionAPI` and injected `visibleWidth` / `truncateToWidth` / clock
 * — no pi runtime required.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
	collectUsageTotals,
	formatSpeedText,
	renderFooterLines,
	type FooterData,
	type SpeedDisplay,
	type TuiLike,
} from "./footer.ts";
import { TpsMeter } from "./tps.ts";

export interface TpsLiveDeps extends TuiLike {
	/** Clock in ms; injectable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Marker for the extension's own footer, used to detect another extension
 * having replaced the footer afterwards (best effort, informational only).
 */
export const FOOTER_MARKER = "pi-tps-live";

/** Minimum ms between render requests while streaming. */
const RENDER_THROTTLE_MS = 150;

interface AssistantMessageLike {
	role: "assistant";
	usage?: { output?: number };
	stopReason?: string;
}

function isAssistant(message: { role?: string } | undefined): message is AssistantMessageLike {
	return message?.role === "assistant";
}

/**
 * Register the extension on a pi instance.
 *
 * @param pi extension API
 * @param deps `visibleWidth` / `truncateToWidth` from pi-tui, plus an optional clock
 */
export function registerTpsLive(pi: ExtensionAPI, deps: TpsLiveDeps): void {
	const now = deps.now ?? (() => Date.now());
	const meter = new TpsMeter();

	let enabled = true;
	let footerInstalled = false;
	let renderTui: { requestRender(): void } | undefined;
	let lastRenderAt = Number.NEGATIVE_INFINITY;

	/** Speed text for the current moment: live when streaming, last reading when idle. */
	function speedDisplay(): SpeedDisplay | undefined {
		if (meter.isStreaming()) {
			const live = meter.live(now());
			if (live) return { text: formatSpeedText(live), live: true };
		}
		const last = meter.last;
		return last ? { text: formatSpeedText(last), live: false } : undefined;
	}

	/** Request a footer repaint, throttled unless forced. */
	function requestRender(force = false): void {
		if (!renderTui) return;
		const t = now();
		if (!force && t - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastRenderAt = t;
		renderTui.requestRender();
	}

	function buildFooterData(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): FooterData {
		const { totals, latestCacheHitRate } = collectUsageTotals(ctx.sessionManager.getEntries());
		const contextUsage = ctx.getContextUsage();
		const model = ctx.model;
		return {
			cwd: ctx.cwd,
			home: process.env.HOME || process.env.USERPROFILE,
			branch: footerData.getGitBranch(),
			sessionName: ctx.sessionManager.getSessionName(),
			totals,
			latestCacheHitRate,
			contextPercent: contextUsage ? contextUsage.percent : null,
			contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
			// Not exposed to extensions; pi's default is enabled. Only affects the "(auto)" hint.
			autoCompactEnabled: true,
			modelId: model?.id,
			modelProvider: model?.provider,
			modelReasoning: model?.reasoning ?? false,
			thinkingLevel: ctx.thinkingLevel,
			providerCount: footerData.getAvailableProviderCount(),
			// Subscription-backed providers pi ships a built-in hint for.
			usingSubscription: model?.provider === "kimi-coding",
			statuses: footerData.getExtensionStatuses(),
			speed: speedDisplay(),
		};
	}

	/** Install the custom footer (TUI mode only). Idempotent. */
	function installFooter(ctx: ExtensionContext): void {
		if (!enabled || footerInstalled || ctx.mode !== "tui") return;
		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			renderTui = tui;
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose() {
					unsubscribe();
					if (renderTui === tui) renderTui = undefined;
				},
				invalidate() {},
				render(width: number) {
					return renderFooterLines(buildFooterData(ctx, footerData), width, theme, deps);
				},
			};
		});
	}

	/** Restore pi's built-in footer. */
	function removeFooter(ctx: ExtensionContext): void {
		if (!footerInstalled) return;
		footerInstalled = false;
		renderTui = undefined;
		ctx.ui.setFooter(undefined);
	}

	// --- events ---------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		meter.reset();
		installFooter(ctx);
	});

	pi.on("model_select", () => {
		// Different model, different throughput: drop the stale idle reading
		// (calibration stays, it is content- and hardware-bound, not model-bound).
		meter.reset();
		requestRender(true);
	});

	pi.on("message_start", (event, ctx) => {
		installFooter(ctx);
		if (isAssistant(event.message)) meter.start();
	});

	pi.on("message_update", (event, ctx) => {
		if (!isAssistant(event.message)) return;
		installFooter(ctx);
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			meter.addDelta(streamEvent.delta, now(), event.message.usage?.output);
		}
		requestRender();
	});

	pi.on("message_end", (event, _ctx) => {
		if (!isAssistant(event.message)) return;
		const { stopReason, usage } = event.message;
		const ok = stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";
		meter.finish(now(), { outputTokens: usage?.output, ok });
		requestRender(true);
	});

	// --- commands -------------------------------------------------------------

	pi.registerCommand("tps", {
		description: "Live tokens-per-second in the footer first line: /tps on|off|reset",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				enabled = false;
				removeFooter(ctx);
				ctx.ui.notify(`${FOOTER_MARKER}: off — built-in footer restored`, "info");
				return;
			}
			if (arg === "on") {
				enabled = true;
				installFooter(ctx);
				requestRender(true);
				ctx.ui.notify(`${FOOTER_MARKER}: on`, "info");
				return;
			}
			if (arg === "reset") {
				meter.reset();
				meter.resetCalibration();
				requestRender(true);
				ctx.ui.notify(`${FOOTER_MARKER}: counters reset`, "info");
				return;
			}
			const reading = meter.live(now()) ?? meter.last;
			if (reading) {
				ctx.ui.notify(
					`tok/s: ${formatSpeedText(reading)} — ${Math.round(reading.tokens)} tokens in ${reading.seconds.toFixed(1)}s${reading.estimated ? " (estimated)" : ""}`,
					"info",
				);
			} else {
				ctx.ui.notify("tok/s: no data yet", "info");
			}
		},
	});
}
