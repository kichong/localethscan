import { PRIVACY_MODE_ENABLED, REDACTED_TOKEN, SENSITIVE_RPC_KEYS } from "./config";

export function getRpcUrlError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "RPC endpoint is required.";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "RPC endpoint must start with http:// or https://.";
    }
    return null;
  } catch {
    return "RPC endpoint URL is invalid.";
  }
}

export function redactRpcUrlForPrivacy(value: string): string {
  if (!PRIVACY_MODE_ENABLED) return value.trim();
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    let changed = false;

    if (url.username) {
      url.username = REDACTED_TOKEN;
      changed = true;
    }
    if (url.password) {
      url.password = REDACTED_TOKEN;
      changed = true;
    }

    for (const key of Array.from(url.searchParams.keys())) {
      const normalizedKey = key.toLowerCase();
      if (SENSITIVE_RPC_KEYS.some((sensitive) => normalizedKey.includes(sensitive))) {
        url.searchParams.set(key, REDACTED_TOKEN);
        changed = true;
      }
    }

    const segments = url.pathname.split("/");
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const prev = (segments[i - 1] ?? "").toLowerCase();
      const looksLikeLongToken = /^[A-Za-z0-9_-]{20,}$/.test(segment);
      const previousSuggestsSecret = /^(v2|v3|api|rpc|key|token)$/.test(prev);
      if (looksLikeLongToken && previousSuggestsSecret) {
        segments[i] = REDACTED_TOKEN;
        changed = true;
      }
    }
    if (changed) url.pathname = segments.join("/");

    return changed ? url.toString() : trimmed;
  } catch {
    return trimmed;
  }
}
