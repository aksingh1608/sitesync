// Why "Save note" is disabled, in words a field worker understands. Pure.
export function saveBlockedReason(input: {
  site: string | null;
  kind: "text" | "voice" | "photo";
  text: string;
  hasRecording: boolean;
  hasPhoto: boolean;
  sitesAvailable: boolean;
}): string | null {
  if (!input.site) return input.sitesAvailable ? "Pick a site first." : "No sites on this device yet. Connect once to sync.";
  if (input.kind === "text" && !input.text.trim()) return "Write your note first.";
  if (input.kind === "voice" && !input.hasRecording) return "Record a voice note first.";
  if (input.kind === "photo" && !input.hasPhoto) return "Take a photo first.";
  return null;
}
