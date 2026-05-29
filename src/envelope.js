// Envelope metadata from the Postfix pipe transport. Convenience helper for
// consumers using the standard pipe contract documented in OPS.md §5:
//
//   argv = receive.sh ${client_address} ${client_helo} ${sender} ${original_recipient}
//
// receive.sh forwards those to the Node process, so process.argv carries them
// at indices 2-5. A consumer on a different transport constructs the envelope
// object ({ clientIp, clientHelo, sender, recipient }) itself and passes it to
// ingest(). Pure: no I/O, no config.

'use strict';

/** @typedef {import('./types').Envelope} Envelope */

/**
 * Parse a Postfix pipe-transport argv into the structured envelope. The four
 * transport fields live at argv indices 2-5. Pure.
 * @param {string[]} argv
 * @returns {Envelope}
 */
function parseEnvelope(argv) {
  const [, , clientIp, clientHelo, sender, recipient] = argv;
  /** @param {string | undefined} v @returns {string | null} */
  const norm = (v) => (v && v !== 'unknown' ? v : null);
  return {
    clientIp: norm(clientIp),
    clientHelo: norm(clientHelo),
    sender: norm(sender),
    recipient: norm(recipient),
  };
}

module.exports = { parseEnvelope };
