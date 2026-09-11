/**
 * pi-tps-live — tokens-per-second tracking (pure logic, no pi imports).
 *
 * Deliberately framework-free so it can be unit-tested without booting the
 * agent or resolving pi's runtime modules. `register.ts` feeds it assistant
 * streaming events; this module owns counting, calibration and the live
 * sliding window.
 *
 * Measurement model:
 * - Decode time starts at the first streamed delta, not at message start.
 *   Including time-to-first-token would let a long thinking phase dominate
 *   the denominator and report meaningless low numbers.
 * - Providers that stream cumulative usage (e.g. Anthropic `output_tokens`)
 *   give exact token counts during the stream.
 * - Providers that only report usage in the final chunk (most
 *   OpenAI-compatible APIs) are estimated from characters. The estimate uses
 *   an ASCII-equivalent character count divided by a chars-per-token ratio
 *   calibrated from completed turns (shrunk toward a prior), so it adapts to
 *   prose vs. code vs. CJK content.
 */

/** A tok/s reading, either live (during a stream) or final (after one). */
export interface TpsReading {
	/** Tokens per second over the measured interval. */
	tps: number;
	/** Tokens counted over the measured interval. */
	tokens: number;
	/** Wall-clock seconds of the measured interval. */
	seconds: number;
	/** True when tokens were estimated from characters (provider streamed no usage). */
	estimated: boolean;
}

/** Live sliding window length, in ms. */
export const LIVE_WINDOW_MS = 5000;
/** Minimum decode time before a live reading is reported. */
export const MIN_LIVE_MS = 600;
/** Minimum token count before a live reading is reported. */
export const MIN_LIVE_TOKENS = 8;
/** Minimum sliding-window span; shorter windows fall back to the whole-stream rate. */
const MIN_WINDOW_MS = 800;

// --- chars-per-token calibration -------------------------------------------
// The live estimate divides ASCII-equivalent characters by this ratio. It is
// learned from completed turns and shrunk toward a code-leaning prior so the
// first turns are still reasonable. At finish time the authoritative
// `usage.output` replaces the estimate, so the prior never pollutes results.
const PRIOR_CHARS_PER_TOKEN = 4;
const PRIOR_WEIGHT_TOKENS = 500;
const MIN_CHARS_PER_TOKEN = 1.2;
const MAX_CHARS_PER_TOKEN = 6;
/** Non-ASCII (CJK / full-width) characters carry ~2.5x the token density of ASCII. */
const NON_ASCII_WEIGHT = 2.5;

/**
 * Count characters in "ASCII-equivalent" units: ASCII counts 1, non-ASCII
 * counts 2.5. Dividing the result by ~4 approximates a token count for mixed
 * prose/code/CJK text (CJK runs ~1.6 chars per token, ASCII ~4).
 */
export function asciiEquivalentChars(text: string): number {
	let ascii = 0;
	let wide = 0;
	for (const ch of text) {
		if (ch.codePointAt(0)! < 128) ascii++;
		else wide++;
	}
	return ascii + wide * NON_ASCII_WEIGHT;
}

interface LiveSample {
	/** Timestamp (ms, same clock as the meter's callers). */
	t: number;
	/** Cumulative estimated tokens at that time (float). */
	tokens: number;
}

/**
 * Per-assistant-message stream meter.
 *
 * Usage: `start()` on message_start, `addDelta(text, now, usageOutput?)`
 * for every text/thinking/toolcall delta, `live(now)` for the footer, and
 * `finish(now, { outputTokens, ok })` on message_end.
 */
export class TpsMeter {
	private calEquiv = 0;
	private calTokens = 0;

	private streaming = false;
	/** Timestamp of the first streamed delta; 0 until one arrives. */
	private decodeStartMs = 0;
	private equiv = 0;
	/** Largest cumulative provider-reported output token count seen in this stream. */
	private providerTokens = 0;
	private samples: LiveSample[] = [];
	private lastReading: TpsReading | undefined;

	/** Begin tracking a new assistant stream. */
	start(): void {
		this.streaming = true;
		this.decodeStartMs = 0;
		this.equiv = 0;
		this.providerTokens = 0;
		this.samples = [];
	}

	/**
	 * Feed one streamed delta.
	 *
	 * @param text delta content (text, thinking or tool-call JSON)
	 * @param now timestamp
	 * @param providerOutputTokens cumulative provider-reported output tokens, when streamed
	 */
	addDelta(text: string, now: number, providerOutputTokens?: number): void {
		// Defensive: if message_start was missed, begin now so data is not lost.
		if (!this.streaming) this.start();
		if (this.decodeStartMs === 0) this.decodeStartMs = now;

		this.equiv += asciiEquivalentChars(text);
		if (providerOutputTokens !== undefined && providerOutputTokens > this.providerTokens) {
			this.providerTokens = providerOutputTokens;
		}

		this.samples.push({ t: now, tokens: this.estimatedTokens() });
		// Drop samples that fell out of the sliding window, keeping at least one.
		const cutoff = now - LIVE_WINDOW_MS;
		let drop = 0;
		while (drop < this.samples.length - 1 && this.samples[drop].t < cutoff) drop++;
		if (drop > 0) this.samples.splice(0, drop);
	}

	/** Estimated tokens accumulated in the current stream (float). */
	estimatedTokens(): number {
		return this.equiv / this.charsPerToken();
	}

	/** Current calibrated ASCII-equivalent chars per token. */
	charsPerToken(): number {
		const ratio =
			(this.calEquiv + PRIOR_CHARS_PER_TOKEN * PRIOR_WEIGHT_TOKENS) / (this.calTokens + PRIOR_WEIGHT_TOKENS);
		return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
	}

	/**
	 * Live reading for the current stream, or undefined while there is not
	 * enough signal yet. Never throws; safe to call every render.
	 */
	live(now: number): TpsReading | undefined {
		if (!this.streaming || this.decodeStartMs === 0) return undefined;
		const seconds = (now - this.decodeStartMs) / 1000;
		const exact = this.providerTokens > 0;
		const tokens = exact ? this.providerTokens : this.estimatedTokens();
		if (seconds <= 0 || seconds * 1000 < MIN_LIVE_MS || tokens < MIN_LIVE_TOKENS) return undefined;

		if (exact) {
			return { tps: tokens / seconds, tokens, seconds, estimated: false };
		}

		// Estimated path: prefer a sliding-window rate for a "live" feel; fall
		// back to the whole-stream average when the window is too short.
		const first = this.samples[0];
		if (first && this.samples.length >= 2) {
			const spanMs = now - first.t;
			const windowTokens = tokens - first.tokens;
			if (spanMs >= MIN_WINDOW_MS && windowTokens > 0) {
				return { tps: windowTokens / (spanMs / 1000), tokens, seconds, estimated: true };
			}
		}
		return { tps: tokens / seconds, tokens, seconds, estimated: true };
	}

	/**
	 * Finish the current stream and remember the reading for idle display.
	 *
	 * @param now timestamp
	 * @param opts.outputTokens final `usage.output` for this message, when available
	 * @param opts.ok true when the turn completed cleanly (calibration uses the
	 *   real token count only then; aborted/errored streams are still measured
	 *   but not learned from)
	 */
	finish(now: number, opts?: { outputTokens?: number; ok?: boolean }): TpsReading | undefined {
		if (!this.streaming) return this.lastReading;
		this.streaming = false;

		// Nothing was streamed (immediate error): keep the previous reading.
		if (this.decodeStartMs === 0) return this.lastReading;

		const seconds = (now - this.decodeStartMs) / 1000;
		const actual = Math.max(0, Math.round(opts?.outputTokens ?? 0));
		const ok = opts?.ok ?? true;
		const tokens = actual > 0 ? actual : Math.round(this.estimatedTokens());

		if (actual > 0 && this.equiv > 0 && ok) {
			this.calEquiv += this.equiv;
			this.calTokens += actual;
		}
		if (seconds < 0.05 || tokens <= 0) {
			this.lastReading = undefined;
			return undefined;
		}
		this.lastReading = { tps: tokens / seconds, tokens, seconds, estimated: actual === 0 };
		return this.lastReading;
	}

	/** Last completed reading (shown while idle), if any. */
	get last(): TpsReading | undefined {
		return this.lastReading;
	}

	/** Whether a stream is currently being measured. */
	isStreaming(): boolean {
		return this.streaming;
	}

	/** Clear stream state and the idle reading, keeping calibration. */
	reset(): void {
		this.streaming = false;
		this.decodeStartMs = 0;
		this.equiv = 0;
		this.providerTokens = 0;
		this.samples = [];
		this.lastReading = undefined;
	}

	/** Clear learned calibration, restoring the prior. */
	resetCalibration(): void {
		this.calEquiv = 0;
		this.calTokens = 0;
	}
}
