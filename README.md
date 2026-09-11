# pi-tps-live

> [中文文档 (Chinese)](README.zh-CN.md)

Live **tokens-per-second** in [pi](https://pi.dev)'s footer — right-aligned at the end of the **first line**, next to your working directory.

```
~/dev/project (main) • refactor-auth                          ⚡ 42.3 tok/s
↑1.2M ↓45k R980k CH82.1% $4.210 37.4%/200k (auto)     claude-opus-4-5 • high
```

While the model is streaming you get a live sliding-window rate in your theme's accent color; when it stops, the number switches to the exact average of the turn just finished (dim).

## Features

- **Right-aligned in the footer's first line** — doesn't collide with token stats, cost, context usage, model name, or other extensions' status lines
- **Live while streaming** — sliding-window tok/s (~5 s window) updated in place as deltas arrive
- **Exact at rest** — after `message_end`, the last turn's average from `usage.output / decode time`
- **Excludes time-to-first-token** — decode timing starts at the first streamed delta, so a long thinking phase doesn't drag the displayed rate down
- **Provider-aware** — providers that stream cumulative usage (Anthropic `output_tokens`, …) get exact live numbers; OpenAI-compatible providers that only report usage in the final chunk get a self-calibrating character estimate, marked with `~`
- **Keeps pi's built-in footer** — pwd/branch/session, `↑↓RW` token counts, cache hit rate, cost, context percentage, model + thinking level, extension statuses: all still there, with the speed added on line 1

## Install

```bash
pi install npm:pi-tps-live
```

Or from git:

```bash
pi install git:github.com/adamcjm/pi-tps-live
```

Then run `/reload` (or restart pi). The readout appears after the first assistant stream of the session.

To try it without installing: `pi -e npm:pi-tps-live`.

## Display

| State | Line 1 right side | Meaning |
|---|---|---|
| Streaming, provider streams usage | `⚡ 42.3 tok/s` | exact, cumulative usage ÷ decode time |
| Streaming, provider hides usage | `⚡ ~42.3 tok/s` | estimate from characters (self-calibrating) |
| Idle | `⚡ 42.3 tok/s` | exact average of the last finished turn |
| No data yet | *(nothing)* | after `/new`, before the first response |

The speed readout is dropped automatically when the terminal is too narrow to show both it and the working directory.

## Commands

| Command | Effect |
|---|---|
| `/tps` | Report the current/last reading in a notification |
| `/tps on` | Enable the footer readout (default) |
| `/tps off` | Restore pi's untouched built-in footer |
| `/tps reset` | Clear the current reading and the learned calibration |

## How the number is measured

- **Decode window** starts at the first streamed `text`/`thinking`/`toolcall` delta, not at message start — TTFT is excluded by design.
- **Exact path** — if the provider streams a cumulative output-token count, the live value is `usage ÷ elapsed` and the final value is `usage.output ÷ decode seconds`.
- **Estimated path** — otherwise characters are counted in ASCII-equivalent units (CJK/full-width ≈ 2.5× an ASCII char) and divided by a chars-per-token ratio. The ratio starts at a code-leaning prior of 4 and is recalibrated on every cleanly finished turn from the real `usage.output`, so it converges to your content mix (code, prose, Chinese, …).
- **Aborted/errored streams** are still measured, but never used for calibration.

## Notes and limitations

- The extension replaces the built-in footer with a faithful copy plus the speed element. If a future pi version changes the footer layout, the copy may lag behind until updated.
- `(auto)` next to the context percentage reflects pi's default auto-compaction setting (the extension API does not expose the live setting).
- The `(sub)` suffix appears for pi's subscription-backed `kimi-coding` provider (other subscription providers are not detectable from an extension).
- Only installed in TUI mode; in `-p` / JSON / RPC modes the extension stays loaded and counts streams but does not touch the footer.

## Development

```bash
bun install          # dev dependencies (pi-coding-agent, pi-ai, pi-tui, typescript)
bun test             # 22 unit checks + 1 end-to-end check on pi's faux provider
bun run typecheck
```

The layout/measurement logic lives in `extensions/pi-tps-live/tps.ts` and `footer.ts` and is framework-free; `register.ts` contains the event wiring and is tested through a fake pi API. The e2e test runs a real `AgentSession` against pi's in-process faux provider (no network, no key).

## License

MIT
