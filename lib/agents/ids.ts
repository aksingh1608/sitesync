// Deterministic UUID v4s for agent writes, so a retried or repeated run
// produces the same event / task ids and the event log turns repeats into
// duplicates instead of second tasks.
import { createHash } from "node:crypto";

export function stableUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Device id on every event an agent writes (shown in task history). */
export const agentDeviceId = (agent: string) => `agent:${agent}`;
