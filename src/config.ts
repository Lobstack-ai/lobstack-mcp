/**
 * Where the Gateway is, where the key comes from, and why neither is a tool
 * argument.
 *
 * This process holds a live credential for the whole time the MCP client is
 * running. Two consequences shape this file.
 *
 * The key is read from the environment once, at construction, and never from a
 * tool call. If `base_url` were a tool argument, any agent — or anything that
 * got a sentence into an agent's context — could point a `chat` call at a host
 * of its choosing and the `Authorization` header would follow. So the base URL
 * is process configuration, full stop. `LOBSTACK_BASE_URL` exists for staging
 * and self-hosted deployments; no tool schema in this repo accepts a URL.
 *
 * And the key never leaves. `scrub()` below runs over every error string that
 * makes it into a tool result, because the one place a credential tends to
 * resurface is in somebody else's error message.
 */

/**
 * The host that answers without a redirect.
 *
 * `lobstack.ai` 307s to `www.lobstack.ai`. RFC 9110 §15.4 requires a client to
 * drop `Authorization` across a host change, so a caller who points at the bare
 * apex gets "missing credentials" back while holding a perfectly good key —
 * which is exactly the failure that made the Gateway look broken for three
 * months. It is corrected, out loud, rather than honoured. See `resolveBase`.
 */
export const DEFAULT_BASE_URL = "https://www.lobstack.ai/api/gateway/v1";

/** The apex, and the host it redirects to. */
const APEX = "lobstack.ai";
const WWW = "www.lobstack.ai";

/** The gateway lives under this prefix; `/api/v1/usage` is its sibling. */
export const GATEWAY_PREFIX = "/api/gateway/v1";

/**
 * The shape a Lobstack API key has: `lsk_{live,test}_` + 8 hex selector + 48
 * hex secret. See `src/lib/api-keys.ts` in the platform.
 *
 * Used for two things and neither of them is admission control: telling a user
 * their token does not look like an API key, and scrubbing anything key-shaped
 * out of text on its way to a tool result. The Gateway also accepts per-agent
 * gateway tokens and the platform agent secret, so a token that fails this test
 * is still sent — refusing it here would lock out self-hosted deployments.
 */
const KEY_SHAPE = /lsk_(?:live|test)_[0-9a-f]{8}[0-9a-f]{48}/g;

export function looksLikeApiKey(token: string): boolean {
  return new RegExp(`^${KEY_SHAPE.source}$`).test(token.trim());
}

export class ConfigError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

export interface ResolvedBase {
  /** Origin only, no trailing slash. Paths are composed from it. */
  origin: string;
  /** True when the apex was rewritten to `www`. Reported, never silent. */
  corrected: boolean;
}

/**
 * Normalise a base URL, and refuse the one that silently breaks auth.
 *
 * Accepts either spelling of the same thing — `https://www.lobstack.ai` and
 * `https://www.lobstack.ai/api/gateway/v1` — because the documented default is
 * the full endpoint and people copy what they read. Both reduce to the origin,
 * which `gatewayUrl` and `apiUrl` then compose against.
 */
export function resolveBase(explicit?: string | null): ResolvedBase {
  const raw = (explicit || process.env.LOBSTACK_BASE_URL || DEFAULT_BASE_URL).trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `LOBSTACK_BASE_URL is not a URL: ${JSON.stringify(raw)}.`,
      `Use an absolute URL, e.g. ${DEFAULT_BASE_URL}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `LOBSTACK_BASE_URL must be http or https, not ${url.protocol.replace(":", "")}.`,
      `Use an absolute URL, e.g. ${DEFAULT_BASE_URL}`,
    );
  }

  // One known redirect, corrected. Someone else's host is left exactly as
  // given: this is not a policy about other people's domains.
  if (url.hostname === APEX) {
    url.hostname = WWW;
    return { origin: url.origin, corrected: true };
  }
  return { origin: url.origin.replace(/\/+$/, ""), corrected: false };
}

/** A path under the OpenAI-compatible gateway, e.g. `/chat/completions`. */
export const gatewayUrl = (origin: string, path: string): string => `${origin}${GATEWAY_PREFIX}${path}`;

/** A path under the platform API, e.g. `/v1/usage`. */
export const apiUrl = (origin: string, path: string): string => `${origin}/api${path}`;

export interface Config {
  base: ResolvedBase;
  /** Null when no credential is configured. The value is never rendered. */
  apiKey: string | null;
  /** True when a key is present but is not shaped like a Lobstack API key. */
  keyShapeUnrecognised: boolean;
}

export function loadConfig(overrides: { baseUrl?: string | null; apiKey?: string | null } = {}): Config {
  const base = resolveBase(overrides.baseUrl ?? null);
  const raw = (overrides.apiKey ?? process.env.LOBSTACK_API_KEY ?? "").trim();
  return {
    base,
    apiKey: raw || null,
    keyShapeUnrecognised: !!raw && !looksLikeApiKey(raw),
  };
}

/**
 * Remove the credential from a string before anybody reads it.
 *
 * Two passes, because there are two ways a key gets into text. The literal
 * configured value covers an upstream that echoes back what it was sent — and
 * a self-hosted gateway token that does not match the `lsk_` shape. The pattern
 * covers a key that arrived from somewhere else entirely: a pasted config, a
 * provider's error body, a log line quoted into a response.
 */
export function scrub(text: string, apiKey?: string | null): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("[redacted]");
  return out.replace(KEY_SHAPE, "[redacted]");
}
