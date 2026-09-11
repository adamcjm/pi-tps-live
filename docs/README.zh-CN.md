# pi-tps-live

> [English (英文文档)](https://github.com/adamcjm/pi-tps-live/blob/main/README.md)

在 [pi](https://pi.dev) 底栏**第一行末端**（固定右侧）实时显示 **tokens/秒**，紧挨着工作目录。

```
~/dev/project (main) • refactor-auth                          ⚡ 42.3 tok/s
↑1.2M ↓45k R980k CH82.1% $4.210 37.4%/200k (auto)     claude-opus-4-5 • high
```

流式生成时显示滑动窗口实时速度（主题强调色高亮）；生成结束后切换为刚完成那一轮的精确平均值（暗色）。

## 特性

- **固定在底栏第一行右端** — 不占用 token 统计、成本、上下文占用、模型名，也不和其它扩展的状态行冲突
- **流式实时** — 约 5 秒滑动窗口，收到增量即刷新
- **空闲精确** — `message_end` 后用 `usage.output ÷ 解码耗时` 显示上一轮平均值
- **排除首 token 延迟（TTFT）** — 从首个流式增量开始计时，长思考阶段不会把显示的速度拉低
- **区分 provider 能力** — 流中提供累计 usage 的（如 Anthropic `output_tokens`）显示精确值；仅在末尾给出 usage 的 OpenAI 兼容 provider 使用可自校准的字符估算，前缀 `~` 标记
- **完整保留 pi 内置底栏** — 工作目录/分支/会话名、`↑↓RW` token、缓存命中率、成本、上下文占用、模型与思考等级、扩展状态行全部保留，仅在第一行右侧加上速度

## 安装

```bash
pi install npm:pi-tps-live
```

或从 git 安装：

```bash
pi install git:github.com/adamcjm/pi-tps-live
```

安装后执行 `/reload`（或重启 pi）。会话中产生第一条助手流式输出后即会显示。

免安装试用：`pi -e npm:pi-tps-live`。

## 显示规则

| 状态 | 第一行右侧 | 含义 |
|---|---|---|
| 流式中，provider 提供 usage | `⚡ 42.3 tok/s` | 精确值：累计 usage ÷ 解码耗时 |
| 流式中，provider 不提供 usage | `⚡ ~42.3 tok/s` | 字符估算（自校准） |
| 空闲 | `⚡ 42.3 tok/s` | 上一轮精确平均速度 |
| 暂无数据 | *（不显示）* | `/new` 之后、首次回复之前 |

终端宽度不足以同时容纳速度与工作目录时，速度显示会自动隐藏。

## 命令

| 命令 | 作用 |
|---|---|
| `/tps` | 用通知报告当前/上次读数 |
| `/tps on` | 启用第一行速度显示（默认） |
| `/tps off` | 恢复 pi 原生底栏 |
| `/tps reset` | 清除当前读数与已学习的校准系数 |

## 速度是怎样计算的

- **解码窗口**从首个 `text`/`thinking`/`toolcall` 增量开始，而非 message_start —— 有意排除 TTFT。
- **精确路径** — provider 在流中给出累计输出 token 时，实时值 = `usage ÷ 已用时长`，最终值 = `usage.output ÷ 解码秒数`。
- **估算路径** — 否则按 "ASCII 等效字符数" 统计（CJK/全角字符 ≈ 2.5 个 ASCII 字符），除以 chars/token 比值。该比值先验为 4（偏代码），并在每次正常完成的轮次后用真实 `usage.output` 自校准，逐步收敛到你实际的内容构成（代码、散文、中文……）。
- **中断/报错的流**仍会显示测得的数值，但不参与校准。

## 说明与限制

- 扩展以"内置底栏的完整拷贝 + 速度元素"替换原底栏。若未来 pi 版本调整底栏布局，拷贝可能滞后，需要随版本更新。
- 上下文百分比旁的 `(auto)` 反映 pi 默认的自动压缩设置（扩展 API 未暴露该运行时设置）。
- `(sub)` 后缀仅对 pi 内置订阅制的 `kimi-coding` provider 显示（其它订阅 provider 无法从扩展侧检测）。
- 仅在 TUI 模式安装底栏；`-p` / JSON / RPC 模式下扩展仍加载并统计，但不改动底栏。

## 开发

```bash
bun install          # 开发依赖（pi-coding-agent、pi-ai、pi-tui、typescript）
bun test             # 22 项单元检查 + 1 项基于 faux provider 的端到端检查
bun run typecheck
```

布局与测量逻辑位于 `extensions/pi-tps-live/tps.ts` 和 `footer.ts`，不依赖 pi 运行时；`register.ts` 是事件接线，通过假的 pi API 测试。端到端测试用 pi 进程内 faux provider 运行真实 `AgentSession`（无需网络与密钥）。

## 许可证

MIT
