// Tool failures (SPEC B12.8): a failed tool is a result with isError and one JSON error object the model can read and act on.

import { UsageError, EX_TEMPFAIL, exitFor } from '../cli/errors.js';

/** An error the server itself raises: a bad argument, a path or size refusal. `code` is the wire code. */
export class ToolError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {string} message @returns {ToolError} */
export const badArgument = (message) => new ToolError('ERR_BAD_ARGUMENT', message);

const MAX_MESSAGE = 2000;

/**
 * The wire form of anything a tool threw: the library's `err.code` when it has one, `ERR_BAD_ARGUMENT` for a TypeError or a
 * usage error, `ERR_INTERNAL` for the rest. `retryable` is true exactly for the codes the CLI maps to exit 75 (B11.8).
 * @param {unknown} e
 * @returns {{ code: string, message: string, retryable: boolean }}
 */
export function toErrorObject(e) {
  const err = /** @type {{ code?: unknown, message?: unknown } | null} */ (e);
  const code = typeof err?.code === 'string' ? err.code : undefined;
  let message = String(err?.message ?? e).slice(0, MAX_MESSAGE);
  if (code === 'ERR_IMAP_AUTH') message = 'the mailbox refused the login: the account credentials in the mailproof config must be fixed; retrying will not help';
  if (e instanceof TypeError || e instanceof UsageError) return { code: 'ERR_BAD_ARGUMENT', message, retryable: false };
  if (code && (code.startsWith('ERR_') || code === 'EX_SECRET_COMMAND')) return { code, message, retryable: exitFor(code) === EX_TEMPFAIL };
  return { code: 'ERR_INTERNAL', message, retryable: false };
}
