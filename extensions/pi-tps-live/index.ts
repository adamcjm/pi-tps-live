/**
 * pi-tps-live — live tokens-per-second in pi's footer.
 *
 * Entry point: wires the pi-tui layout helpers into the extension.
 * See `register.ts` for behavior and `tps.ts` for the measurement logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerTpsLive } from "./register.ts";

export default function tpsLiveExtension(pi: ExtensionAPI): void {
	registerTpsLive(pi, { visibleWidth, truncateToWidth });
}
