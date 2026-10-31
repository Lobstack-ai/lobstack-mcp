/**
 * The client tag, as a tool argument.
 *
 * A client tag says who a call was made for, so spend can be grouped and
 * budgeted per customer (lobstack_spend group_by "client"). The Gateway reads
 * it from `x-lobstack-client-tag`; a tag set on the API key itself wins.
 * Validated here with the Gateway's own rule so a bad tag fails before money
 * is reserved, with the same sentence.
 */
import { z } from "zod";
import { CLIENT_TAG_HEADER } from "../gateway.js";

export const CLIENT_TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const clientTagArg = z
  .string()
  .regex(CLIENT_TAG_RE, "1–64 characters of a–z, 0–9, '.', '_' or '-', starting with a letter or digit")
  .optional()
  .describe(
    "Optional cost-attribution tag naming who this call is for, e.g. \"acme\" or \"acme.support\". 1–64 characters of " +
      "lowercase a–z, 0–9, '.', '_' or '-', starting with a letter or digit. Sent as the x-lobstack-client-tag header; " +
      'read it back with lobstack_spend group_by "client". If the API key carries its own tag, the key\'s tag wins. ' +
      "A client with a hard budget that is spent refuses the call with 402 CLIENT_BUDGET_EXHAUSTED.",
  );

export const tagHeaders = (tag: string | undefined): Record<string, string> =>
  tag ? { [CLIENT_TAG_HEADER]: tag } : {};
