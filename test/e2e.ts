/**
 * pi-tps-live end-to-end check.
 *
 *   bun run test/e2e.ts
 *
 * Runs a real `AgentSession` against pi's in-process faux provider (no
 * network, no API key), forwards the genuine event stream
 * (message_start → N × message_update → message_end) into the extension's
 * handlers, and captures footer renders through a stub TUI. This exercises
 * the full path that unit tests fake: real pi event ordering, real usage
 * numbers, real streaming timing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { registerTpsLive } from "../extensions/pi-tps-live/register.ts";

let checks = 0;
function ok(name: string): void {
	checks++;
	console.log(`ok ${checks} - ${name}`);
}

// --- stubs ------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const plainTheme = { fg: (_color: string, text: string) => text.replace(ANSI_RE, "") };
const widthOf = (text: string): number => [...text.replace(ANSI_RE, "")].length;
const layout = {
	visibleWidth: widthOf,
	truncateToWidth: (text: string, width: number, ellipsis = "") =>
		widthOf(text) <= width ? text : [...text.replace(ANSI_RE, "")].slice(0, Math.max(0, width - widthOf(ellipsis))).join("") + ellipsis,
};

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
class FakePi {
	handlers = new Map<string, AnyHandler[]>();
	on(event: string, handler: AnyHandler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}
	registerCommand(): void {}
	emit(event: string, payload: unknown, ctx: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload, ctx);
	}
}

let footerFactory: ((tui: unknown, theme: unknown, footerData: unknown) => { render(w: number): string[] }) | undefined;
const fakeTuiInstance = { requestRender: () => {} };
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};
// Filled in once the real session exists; the footer reads through it.
const sessionManagerRef: { current?: { getEntries(): unknown[]; getSessionName(): string | undefined } } = {};
const fakeCtx = {
	mode: "tui",
	cwd: "/Users/dev/project",
	thinkingLevel: "off",
	model: { id: "faux-model", provider: "faux-e2e", reasoning: false, contextWindow: 128000 },
	getContextUsage: () => ({ percent: 0.1, contextWindow: 128000 }),
	sessionManager: {
		getEntries: () => sessionManagerRef.current?.getEntries() ?? [],
		getSessionName: () => sessionManagerRef.current?.getSessionName(),
	},
	ui: {
		setFooter: (factory: unknown) => {
			footerFactory = factory as typeof footerFactory;
		},
		notify: () => {},
	},
};

// --- real session on the faux provider --------------------------------------

const tmp = await mkdtemp(join(tmpdir(), "pi-tps-live-e2e-"));
try {
	const faux = fauxProvider({
		provider: "faux-e2e",
		models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
		tokensPerSecond: 200,
	});
	// 800 chars ≈ 200 tokens ≈ one second of simulated streaming.
	faux.setResponses([fauxAssistantMessage("x".repeat(800))]);

	const modelRuntime = await ModelRuntime.create({
		refreshOnCreate: false,
		authPath: join(tmp, "auth.json"),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	// Isolated resource loader: no user extensions/settings leak into the test.
	const resourceLoader = new DefaultResourceLoader({ cwd: tmp, agentDir: tmp });
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: tmp,
		model: faux.models[0],
		modelRuntime,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		tools: [],
	});
	sessionManagerRef.current = session.sessionManager;

	// Wire the extension against the real event stream.
	const pi = new FakePi();
	registerTpsLive(pi as unknown as ExtensionAPI, layout);
	pi.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx);
	const factory = footerFactory;
	assert.ok(factory, "footer factory installed");
	const component = factory(fakeTuiInstance, plainTheme, footerData);

	let liveSamples = 0;
	let updates = 0;
	session.subscribe((event) => {
		pi.emit(event.type, event, fakeCtx);
		if (event.type === "message_update") {
			updates++;
			const line = component.render(80)[0] ?? "";
			// The faux provider reports usage up front, so this stream takes the
			// exact path: a live value without the `~` estimate prefix.
			if (line.includes("⚡ ") && line.endsWith("tok/s")) liveSamples++;
		}
	});

	await session.prompt("hello");

	assert.ok(updates > 10, `stream produced many updates (got ${updates})`);
	const finalLine = component.render(80)[0] ?? "";
	assert.ok(liveSamples > 0, "live speed observed during streaming");
	assert.ok(finalLine.includes("⚡ "), "speed readout present after the turn");
	assert.ok(!finalLine.includes("~"), "final readout is exact (usage.output available)");
	assert.ok(finalLine.endsWith("tok/s"), "speed readout stays right-aligned on the first line");

	const tps = Number(finalLine.slice(finalLine.indexOf("⚡ ") + 2).split(" ")[0]);
	assert.ok(tps > 30 && tps < 1000, `final tok/s is plausible (got ${tps})`);

	// Footer still mirrors the built-in layout: pwd on the left, stats on line 2.
	assert.ok(finalLine.includes("~/project") || finalLine.includes("project"), "pwd kept on line 1");
	const line2 = component.render(80)[1] ?? "";
	assert.ok(line2.includes("↑"), "token stats rendered on line 2");

	ok("end-to-end: faux-provider stream drives live tok/s, exact average at rest");

	session.dispose();
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${checks} e2e checks passed`);
