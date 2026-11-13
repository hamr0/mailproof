// Exit codes and error classes shared by `mailproof` and `mailproof-sync` (SPEC B4.1, B11.8).

export const EX_OK = 0;
export const EX_ERR = 1;
export const EX_NO = 2;        // a check ran and the answer is "no" (verify, check): not an error
export const EX_USAGE = 64;
export const EX_TEMPFAIL = 75;
export const EX_NOPERM = 77;

/** Bad usage: unknown command or flag, missing value, bad config. Exit 64. */
export class UsageError extends Error {}

/** A permission problem the caller must fix (config owner or mode). Exit 77. */
export class PermError extends Error {}

/**
 * The exit code for a library or secret-command error code.
 * @param {string | undefined} code
 * @returns {number}
 */
export function exitFor(code) {
  switch (code) {
    case 'ERR_SYNC_LOCKED': case 'ERR_TRAIL_LOCKED': case 'ERR_STAMP_LOCKED': case 'ERR_EXPORT_REWRITTEN': case 'ERR_IMAP_CONNECT': case 'ERR_IMAP_TIMEOUT':
    case 'ERR_IMAP_THROTTLED': case 'ERR_IMAP_UIDVALIDITY': case 'EX_SECRET_COMMAND':
      return EX_TEMPFAIL;
    case 'ERR_IMAP_AUTH': return EX_NOPERM;
    case 'ERR_EXPORT_EXISTS': return EX_USAGE;   // `out` exists, or is inside the trail: a usage problem (B13.2.9)
    default: return EX_ERR;
  }
}

/**
 * The exit code for anything thrown by a command.
 * @param {unknown} e
 * @returns {number}
 */
export function exitForError(e) {
  if (e instanceof UsageError) return EX_USAGE;
  if (e instanceof PermError) return EX_NOPERM;
  const code = /** @type {{ code?: string } | null} */ (e)?.code;
  if (e instanceof TypeError || code === 'ERR_BAD_PROFILE') return EX_USAGE;   // the library refused a bad argument
  return exitFor(code);
}
