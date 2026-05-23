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

function parseEnvelope(argv) {
  const [, , clientIp, clientHelo, sender, recipient] = argv;
  const norm = (v) => (v && v !== 'unknown' ? v : null);
  return {
    clientIp: norm(clientIp),
    clientHelo: norm(clientHelo),
    sender: norm(sender),
    recipient: norm(recipient),
  };
}

module.exports = { parseEnvelope };
