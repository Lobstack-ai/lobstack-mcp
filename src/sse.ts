/**
 * Read an OpenAI-compatible SSE stream, and keep the receipt.
 *
 * Three things here are load-bearing, and all three are the same rule as
 * `cli/src/stream.mjs` in the platform repo — deliberately, because two
 * different readers for one wire format is two chances to disagree about what
 * the seller said a call cost.
 *
 * The splitter buffers across chunk boundaries. A JSON frame can be cut in the
 * middle by the network, and parsing per chunk instead of per frame drops
 * tokens — which surfaces as answers that end mid-sentence and that nobody can
 * reproduce.
 *
 * The trailing buffer is flushed at end of stream. A server that closes without
 * a final blank line still owes us its last event, and the last event is the
 * one carrying the price.
 *
 * `\r\n\r\n` is accepted alongside `\n\n`. Our gateway emits `\n\n`; a proxy in
 * between is entitled to normalise line endings, and a reader that only knows
 * one of the two spellings loses every frame when it does.
 */

/** Yield each `data:` payload from an SSE body, whole. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 4 : 2));
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ConsumedStream {
  text: string;
  usage: StreamUsage | null;
  /** `x_lobstack` off the trailing frame, verbatim. Null if it never arrived. */
  receipt: unknown;
  /** The model the frames named, which is the model that actually served. */
  model: string | null;
  finishReason: string | null;
}

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

/**
 * Consume a completion stream to the end.
 *
 * The whole answer is accumulated rather than forwarded: an MCP tool result is
 * one message, so there is nowhere to stream it to. The request is still made
 * with `stream: true` and `include_usage`, because the trailing SSE frame is the
 * only place the Gateway reports a streamed call's price — headers are written
 * before the provider has counted a token.
 */
export async function consume(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<ConsumedStream> {
  let text = "";
  let usage: StreamUsage | null = null;
  let receipt: unknown = null;
  let model: string | null = null;
  let finishReason: string | null = null;

  for await (const payload of sseFrames(body)) {
    if (payload === "[DONE]") break;

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // a half-frame is not worth ending a turn over
    }

    if (frame.error) {
      const e = frame.error as { message?: string };
      // A 200 whose stream carries an error. Headers are long gone by then, so
      // this is the only place the gateway can report a mid-stream failure.
      throw new StreamError(e?.message || "the gateway reported an error mid-stream");
    }
    if (typeof frame.model === "string") model = frame.model;
    if (frame.usage && typeof frame.usage === "object") usage = frame.usage as StreamUsage;
    if (frame.x_lobstack !== undefined && frame.x_lobstack !== null) receipt = frame.x_lobstack;

    const choices = frame.choices as Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> | undefined;
    const first = choices?.[0];
    if (first?.finish_reason) finishReason = first.finish_reason;
    const delta = first?.delta?.content;
    if (typeof delta === "string" && delta.length) {
      text += delta;
      onText?.(delta);
    }
  }

  return { text, usage, receipt, model, finishReason };
}
