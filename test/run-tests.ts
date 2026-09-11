/**
 * pi-tps-live self-check.
 *
 *   bun run test/run-tests.ts      (or: npm test)
 *
 * Covers the measurement state machine (`tps.ts`), footer layout
 * (`footer.ts`) and the stream event wiring (`register.ts`, driven through a
 * fake pi API). No network, no real agent, no terminal required.
 */

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectUsageTotals,
	formatCwdForFooter,
	formatSpeedText,
	formatTokens,
	type FooterData,
	renderFooterLines,
	sanitizeStatusText,
	type TuiLike,
} from "../extensions/pi-tps-live/footer.ts";
import { registerTpsLive } from "../extensions/pi-tps-live/register.ts";
import { asciiEquivalentChars, MIN_LIVE_TOKENS, TpsMeter } from "../extensions/pi-tps-live/tps.ts";

let checks = 0;
function ok(name: string): void {
	checks++;
	console.log(`ok ${checks} - ${name}`);
}

// --- test doubles -----------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** Crude terminal width: emoji/symbols and CJK are double-width. */
function charWidth(cp: number): number {
	if (cp >= 0x1f000) return 2;
	if (cp >= 0x2600 && cp <= 0x27bf) return 2;
	if (
		cp >= 0x1100 &&
		(cp <= 0x115f ||
			cp === 0x2329 ||
			cp === 0x232a ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe4f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6))
	)
		return 2;
	return 1;
}

/** Layout helper double. Only used with the plain (ANSI-free) theme below. */
const fakeTui: TuiLike = {
	visibleWidth(text: string): number {
		let width = 0;
		for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0)!);
		return width;
	},
	truncateToWidth(text: string, width: number, ellipsis = ""): string {
		if (fakeTui.visibleWidth(text) <= width) return text;
		const budget = Math.max(0, width - fakeTui.visibleWidth(ellipsis));
		let out = "";
		let used = 0;
		for (const ch of stripAnsi(text)) {
			const w = charWidth(ch.codePointAt(0)!);
			if (used + w > budget) break;
			out += ch;
			used += w;
		}
		return out + ellipsis;
	},
};

/** No colors: keeps layout assertions readable. */
const plainTheme = { fg: (_color: string, text: string) => text };

function baseFooterData(overrides: Partial<FooterData> = {}): FooterData {
	return {
		cwd: "/Users/dev/project",
		home: "/Users/dev",
		branch: "main",
		sessionName: "my session",
		totals: { input: 12345, output: 6789, cacheRead: 5000, cacheWrite: 0, cost: 0.42 },
		latestCacheHitRate: 28.8,
		contextPercent: 12.3,
		contextWindow: 200000,
		autoCompactEnabled: true,
		modelId: "deepseek-flash",
		modelProvider: "deepseek",
		modelReasoning: true,
		thinkingLevel: "high",
		providerCount: 1,
		usingSubscription: false,
		statuses: new Map(),
		speed: { text: "42.3 tok/s", live: true },
		...overrides,
	};
}

// --- tps.ts -----------------------------------------------------------------

assert.equal(asciiEquivalentChars("abcd"), 4, "pure ASCII counts 1:1");
assert.equal(asciiEquivalentChars("你好"), 5, "CJK counts 2.5 per char");
assert.equal(asciiEquivalentChars("ab你好"), 7, "mixed text adds up");
ok("asciiEquivalentChars");

{
	const meter = new TpsMeter();
	meter.start();
	// 8 ASCII chars = 2 estimated tokens, every 200ms → 10 tok/s.
	for (let i = 1; i <= 10; i++) meter.addDelta("abcdefgh", i * 200);
	const live = meter.live(2000);
	assert.ok(live, "live reading is available");
	assert.equal(live!.estimated, true, "estimated without provider usage");
	assert.ok(Math.abs(live!.tps - 10) < 0.05, `expected ~10 tok/s, got ${live!.tps.toFixed(2)}`);
	assert.ok(Math.abs(live!.tokens - 20) < 0.001, "estimated token total");
	assert.ok(Math.abs(live!.seconds - 1.8) < 1e-9, "decode time starts at first delta");
}
ok("TpsMeter live estimate (sliding window)");

{
	const meter = new TpsMeter();
	meter.start();
	meter.addDelta("ab", 100);
	assert.equal(meter.live(1000), undefined, `below MIN_LIVE_TOKENS (${MIN_LIVE_TOKENS})`);
	meter.addDelta("abcdefghijklmnopqrstuvwxyzabcd", 700);
	assert.ok(meter.live(700), "enough tokens after warm-up");
}
ok("TpsMeter live thresholds");

{
	const meter = new TpsMeter();
	meter.start();
	meter.addDelta("abc", 500, 3);
	meter.addDelta("abc", 1000, 10);
	meter.addDelta("abc", 1500, 20);
	const live = meter.live(1500);
	assert.ok(live, "live reading with provider usage");
	assert.equal(live!.estimated, false, "provider usage marks the reading exact");
	assert.ok(Math.abs(live!.tps - 20) < 1e-9, "exact path divides usage by elapsed decode time");
}
ok("TpsMeter provider-streamed usage path");

{
	const meter = new TpsMeter();
	meter.start();
	// 40 ASCII chars = 10 (prior) tokens per second for 20 seconds.
	for (let i = 1; i <= 20; i++) meter.addDelta("a".repeat(40), i * 1000);
	const live = meter.live(20000);
	assert.ok(live, "live reading from a long stream");
	// The window keeps t=15000..20000: (200 - 150) tokens over 5s → 10 tok/s.
	assert.ok(Math.abs(live!.tps - 10) < 1e-9, `window rate, got ${live!.tps.toFixed(2)}`);
	assert.ok(Math.abs(live!.tokens - 200) < 0.001, "cumulative estimate");
}
ok("TpsMeter sliding window drops old samples");

{
	const meter = new TpsMeter();
	meter.start();
	for (let i = 1; i <= 10; i++) meter.addDelta("abcdefgh", i * 200);
	const final = meter.finish(2100, { outputTokens: 20, ok: true });
	assert.ok(final, "final reading");
	assert.equal(final!.estimated, false, "final uses usage.output");
	assert.ok(Math.abs(final!.tps - 20 / 1.9) < 1e-9, "final rate = tokens / decode seconds");
	assert.equal(meter.isStreaming(), false, "streaming cleared");
	assert.equal(meter.last!.tps, final!.tps, "idle reading kept");
	// 80 chars with 20 real tokens: (80 + 4*500) / (20 + 500) ≈ 4.15
	const ratio = meter.charsPerToken();
	assert.ok(ratio > 3.5 && ratio < 4.5, `calibration moved toward observation, got ${ratio.toFixed(2)}`);
}
ok("TpsMeter finish uses provider usage and calibrates");

{
	const meter = new TpsMeter();
	meter.start();
	for (let i = 1; i <= 5; i++) meter.addDelta("abcdefgh", i * 200);
	const final = meter.finish(1000, { outputTokens: 0, ok: false });
	assert.ok(final, "aborted stream still reports a reading");
	assert.equal(final!.estimated, true, "aborted stream is estimated");
	const before = meter.charsPerToken();
	assert.equal(before, 4, "aborted stream does not calibrate");
}
ok("TpsMeter ignores aborted streams for calibration");

{
	const meter = new TpsMeter();
	meter.start();
	meter.addDelta("x".repeat(800), 1000);
	meter.finish(2000, { outputTokens: 100, ok: true });
	assert.notEqual(meter.charsPerToken(), 4, "calibration learned from a clean turn");
	meter.resetCalibration();
	assert.equal(meter.charsPerToken(), 4, "reset restores the prior");
	meter.reset();
	assert.equal(meter.last, undefined, "reset clears the idle reading");
}
ok("TpsMeter reset and resetCalibration");

{
	const meter = new TpsMeter();
	meter.start();
	meter.addDelta("x".repeat(400), 1000);
	meter.finish(3000, { outputTokens: 50, ok: true });
	const kept = meter.last!.tps;
	meter.start();
	const reread = meter.finish(3100, { outputTokens: 0, ok: false }); // no deltas at all
	assert.ok(reread, "empty stream keeps the previous reading");
	assert.equal(reread!.tps, kept, "previous reading survives an empty stream");
}
ok("TpsMeter keeps last reading through an empty stream");

// --- footer.ts --------------------------------------------------------------

assert.equal(formatTokens(999), "999");
assert.equal(formatTokens(12345), "12k");
assert.equal(formatTokens(6789), "6.8k");
assert.equal(formatTokens(999999), "1000k");
assert.equal(formatTokens(1500000), "1.5M");
assert.equal(formatTokens(15000000), "15M");
ok("formatTokens buckets");

assert.equal(formatCwdForFooter("/Users/dev/project", "/Users/dev"), "~/project");
assert.equal(formatCwdForFooter("/Users/dev", "/Users/dev"), "~");
assert.equal(formatCwdForFooter("/opt/other", "/Users/dev"), "/opt/other");
assert.equal(formatCwdForFooter("/Users/dev", undefined), "/Users/dev");
ok("formatCwdForFooter");

assert.equal(sanitizeStatusText("a\nb\tc   d "), "a b c d");
assert.equal(sanitizeStatusText("\n\n"), "");
ok("sanitizeStatusText");

assert.equal(formatSpeedText({ tps: 42.34, estimated: false }), "42.3 tok/s");
assert.equal(formatSpeedText({ tps: 42.34, estimated: true }), "~42.3 tok/s");
assert.equal(formatSpeedText({ tps: 143.2, estimated: false }), "143 tok/s");
ok("formatSpeedText");

{
	const { totals, latestCacheHitRate } = collectUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, cost: { total: 0.01 } },
			},
		},
		{ type: "message", message: { role: "user" } },
		{
			type: "message",
			message: { role: "toolResult", usage: { input: 10, output: 2, cost: { total: 0.001 } } },
		},
		{ type: "compaction", usage: { input: 7, output: 3, cost: { total: 0.002 } } },
	]);
	assert.deepEqual(totals, { input: 117, output: 55, cacheRead: 25, cacheWrite: 5, cost: 0.013 });
	assert.ok(Math.abs(latestCacheHitRate! - (25 / 130) * 100) < 1e-9, "cache hit rate from latest assistant turn");
}
ok("collectUsageTotals");

{
	const lines = renderFooterLines(baseFooterData(), 80, plainTheme, fakeTui);
	assert.equal(lines.length, 2, "two lines without statuses");
	assert.equal(fakeTui.visibleWidth(lines[0]!), 80, "line 1 fills the width");
	assert.ok(lines[0]!.endsWith("⚡ 42.3 tok/s"), "speed is right-aligned on line 1");
	assert.ok(lines[0]!.includes("~/project (main) • my session"), "pwd/branch/session on the left of line 1");
	assert.ok(lines[1]!.includes("↑12k"), "input tokens on line 2");
	assert.ok(lines[1]!.includes("↓6.8k"), "output tokens on line 2");
	assert.ok(lines[1]!.includes("R5.0k"), "cache read on line 2");
	assert.ok(lines[1]!.includes("CH28.8%"), "cache hit rate on line 2");
	assert.ok(lines[1]!.includes("$0.420"), "cost on line 2");
	assert.ok(lines[1]!.includes("12.3%/200k (auto)"), "context usage on line 2");
	assert.ok(lines[1]!.endsWith("deepseek-flash • high"), "model right-aligned on line 2");
}
ok("renderFooterLines built-in layout + speed on line 1");

{
	const lines = renderFooterLines(baseFooterData({ speed: undefined }), 80, plainTheme, fakeTui);
	assert.ok(!lines[0]!.includes("tok/s"), "no speed when no reading");
	assert.ok(lines[0]!.includes("~/project"), "pwd still shown");
	assert.ok(fakeTui.visibleWidth(lines[0]!) <= 80, "line 1 fits the width");
}
ok("renderFooterLines without a reading");

{
	const lines = renderFooterLines(baseFooterData(), 30, plainTheme, fakeTui);
	assert.equal(fakeTui.visibleWidth(lines[0]!), 30, "narrow width respected");
	assert.ok(lines[0]!.endsWith("⚡ 42.3 tok/s"), "speed survives a narrow footer");
	assert.ok(lines[0]!.includes("..."), "pwd truncated with an ellipsis");
}
ok("renderFooterLines truncates pwd before dropping the speed");

{
	const lines = renderFooterLines(baseFooterData(), 15, plainTheme, fakeTui);
	assert.ok(!lines[0]!.includes("tok/s"), "speed dropped when there is no room");
	assert.ok(fakeTui.visibleWidth(lines[0]!) <= 15, "line 1 fits the terminal");
}
ok("renderFooterLines drops speed on a tiny terminal");

{
	const lines = renderFooterLines(
		baseFooterData({ contextPercent: null, providerCount: 3, usingSubscription: true }),
		100,
		plainTheme,
		fakeTui,
	);
	assert.ok(lines[1]!.includes("?/200k (auto)"), "unknown context percent renders as ?");
	assert.ok(lines[1]!.includes("$0.420 (sub)"), "subscription suffix");
	assert.ok(lines[1]!.endsWith("(deepseek) deepseek-flash • high"), "provider prefix when several providers exist");
}
ok("renderFooterLines provider prefix, subscription and unknown context");

{
	const lines = renderFooterLines(
		baseFooterData({
			statuses: new Map([
				["b", "B status"],
				["a", "A\nstatus"],
			]),
		}),
		80,
		plainTheme,
		fakeTui,
	);
	assert.equal(lines.length, 3, "status line appended");
	assert.equal(lines[2], "A status B status", "statuses sanitized and sorted by key");
}
ok("renderFooterLines status line");

// --- register.ts wiring (fake pi) -------------------------------------------

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
	handlers = new Map<string, AnyHandler[]>();
	commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

	on(event: string, handler: AnyHandler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	emit(event: string, payload: unknown, ctx: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
	}
}

{
	let clock = 0;
	let renders = 0;
	let footerFactory: ((tui: unknown, theme: unknown, footerData: unknown) => { render(w: number): string[] }) | undefined;
	const notifications: string[] = [];

	const fakeTuiInstance = {
		requestRender: () => {
			renders++;
		},
	};
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const ctx = {
		mode: "tui",
		cwd: "/Users/dev/project",
		thinkingLevel: "off",
		model: { id: "test-model", provider: "test", reasoning: false, contextWindow: 100000 },
		getContextUsage: () => ({ percent: 1.5, contextWindow: 100000 }),
		sessionManager: { getEntries: () => [], getSessionName: () => undefined },
		ui: {
			setFooter: (factory: unknown) => {
				footerFactory = factory as typeof footerFactory;
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};

	const pi = new FakePi();
	registerTpsLive(pi as unknown as ExtensionAPI, {
		visibleWidth: fakeTui.visibleWidth,
		truncateToWidth: fakeTui.truncateToWidth,
		now: () => clock,
	});
	// Accessor defeats TS control-flow narrowing across the setFooter callback.
	const footerFactoryRef = () => footerFactory;

	pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	const installedFactory = footerFactoryRef();
	assert.ok(installedFactory, "custom footer installed on session_start");

	const component = installedFactory(fakeTuiInstance, plainTheme, footerData);

	// No data yet: no speed on line 1.
	assert.ok(!component.render(70)[0]!.includes("tok/s"), "no speed before any stream");

	// Stream 10 deltas of 8 ASCII chars (2 estimated tokens) every 200ms.
	clock = 0;
	pi.emit("message_start", { type: "message_start", message: { role: "assistant" } }, ctx);
	for (let i = 1; i <= 10; i++) {
		clock = i * 200;
		pi.emit(
			"message_update",
			{
				type: "message_update",
				message: { role: "assistant", usage: { output: 0 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcdefgh" },
			},
			ctx,
		);
	}
	let line1 = component.render(70)[0]!;
	assert.ok(line1.includes("⚡ ~"), "live estimated speed shown while streaming");
	assert.ok(line1.endsWith("tok/s"), "live speed right-aligned");
	assert.ok(renders > 0, "footer repaints requested while streaming");

	// Finish with authoritative usage: 20 tokens over 1.9s.
	clock = 2100;
	pi.emit(
		"message_end",
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		},
		ctx,
	);
	line1 = component.render(70)[0]!;
	assert.ok(line1.endsWith("⚡ 10.5 tok/s"), `idle average after finish, got: ${line1.slice(-30)}`);

	// Throttling: several updates at the same timestamp repaint once.
	const before = renders;
	clock = 5000;
	for (let i = 0; i < 3; i++) {
		pi.emit(
			"message_update",
			{
				type: "message_update",
				message: { role: "assistant", usage: { output: 0 } },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ab" },
			},
			ctx,
		);
	}
	assert.equal(renders - before, 1, "same-timestamp updates are throttled to one repaint");

	// Non-assistant messages do not touch the meter.
	pi.emit("message_start", { type: "message_start", message: { role: "user" } }, ctx);
	pi.emit("message_end", { type: "message_end", message: { role: "user" } }, ctx);

	// Commands: /tps (report), /tps off, /tps on, /tps reset.
	const tps = pi.commands.get("tps");
	assert.ok(tps, "/tps command registered");
	await tps!.handler("", ctx);
	assert.ok(notifications.some((n) => n.includes("tok/s")), "/tps reports the current reading");
	await tps!.handler("off", ctx);
	assert.equal(footerFactoryRef(), undefined, "/tps off restores the built-in footer");
	await tps!.handler("on", ctx);
	const reinstalledFactory = footerFactoryRef();
	assert.ok(reinstalledFactory, "/tps on re-installs the footer");
	await tps!.handler("reset", ctx);
	const resetFactory = footerFactoryRef();
	assert.ok(resetFactory, "footer still installed after reset");
	const resetComponent = resetFactory(fakeTuiInstance, plainTheme, footerData);
	assert.ok(!resetComponent.render(70)[0]!.includes("tok/s"), "/tps reset clears the reading");
}
ok("registerTpsLive wiring, streaming display, commands");

// --- optional: agree with the real pi-tui width helpers ---------------------

try {
	const tui = await import("@earendil-works/pi-tui");
	assert.equal(tui.visibleWidth("⚡ 42.3 tok/s"), fakeTui.visibleWidth("⚡ 42.3 tok/s"), "emoji width matches pi-tui");
	assert.equal(tui.visibleWidth("你好 abc"), fakeTui.visibleWidth("你好 abc"), "CJK width matches pi-tui");
	ok("pi-tui width consistency");
} catch {
	console.log("# pi-tui not installed; skipped width consistency check");
}

console.log(`\n${checks} checks passed`);
