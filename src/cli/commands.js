// The command table (SPEC B11.5, B11.11): one place that names every command, its positionals and its flags. The
// dispatcher builds `parseArgs` from it, `help` prints it, the menu labels come from it. The library's own text
// (`@when`, `@fails`) is NOT retyped: a command with a `primitive` takes it from primitives.json when the help is
// generated (`npm run build:cli-help`); only commands with no primitive carry their text here, written once.

/**
 * @typedef {Object} FlagSpec
 * @property {'string' | 'boolean'} type
 * @property {string} [short]
 * @property {string} [arg]  The value's name in help (`<date>`).
 * @property {string} help
 */
/**
 * @typedef {Object} CommandSpec
 * @property {string} [primitive]  Name in primitives.json (`Mailproof#list`): the source of `when` and `fails`.
 * @property {string} summary  One line, for the command list and the menu.
 * @property {string} [when]  Own text, for a command with no primitive.
 * @property {string} [fails]  Own text, for a command with no primitive.
 * @property {boolean} account  Runs on one account (needs the config and `--account` per SPEC B11.3).
 * @property {string} positional  `''`, or the usage of the positional arguments (`<id>`, `[id ...]`).
 * @property {number} min  Fewest positionals.
 * @property {number} max  Most positionals.
 * @property {Record<string, FlagSpec>} flags  Beyond the global flags.
 */

/** Global flags: accepted by every command, before or after it. */
export const GLOBAL_FLAGS = /** @type {Record<string, FlagSpec>} */ ({
  account: { type: 'string', arg: '<name>', help: 'the account to run on (needed when the config holds more than one)' },
  config: { type: 'string', arg: '<path>', help: 'the config file (default $XDG_CONFIG_HOME/mailproof/config.json)' },
  json: { type: 'boolean', help: 'print one JSON document on stdout instead of text' },
  help: { type: 'boolean', short: 'h', help: 'show this help' },
});

/** @type {FlagSpec} */
const YES = { type: 'boolean', help: 'do the destructive thing; without it only the summary is printed and the exit code is 64' };
/** @type {FlagSpec} */
const DRY = { type: 'boolean', help: 'print only the summary of what would happen, change nothing' };

/** @type {Record<string, CommandSpec>} */
export const COMMANDS = {
  sync: {
    primitive: 'Mailproof#sync', summary: 'fetch new mail (Inbox + Sent), record proofs', account: true, positional: '', min: 0, max: 0,
    flags: {
      folders: { type: 'string', arg: '<a,b>', help: 'folders to read for this run (default: the account\'s)' },
      sent: { type: 'string', arg: '<on|off|path>', help: 'also read the Sent folder: on, off or a folder path (default: the account\'s)' },
    },
  },
  watch: {
    summary: 'sync every 5 min until Ctrl-C', account: true, positional: '', min: 0, max: 0,
    when: 'Use to keep a trail current without a scheduler: it runs `sync` for the account, waits, and repeats, in the foreground, until Ctrl-C or SIGTERM. mailproof has no daemon: run it from systemd or a terminal multiplexer. A second watch or a manual sync on the same account waits for the lock (a watch tick logs "skipped (locked)"). The login is refused: it stops (exit 77), because retrying a refused login every few minutes can lock the account. A transient error (server unreachable, timeout, throttled) is logged and retried, with the wait doubled up to 1 h and reset after a success. Every tick re-reads the secret, so a fresh OAuth token is fetched each time. With --json it prints one JSON line per tick.',
    fails: 'Exit 0 after Ctrl-C or SIGTERM (the sync in progress finishes first; a second signal exits at once), 77 when the login is refused, 64 for a bad interval or config, 1 for any other error.',
    flags: { interval: { type: 'string', arg: '<dur>', help: 'time between syncs: 30s, 5m, 1h (default 5m, minimum 30s)' } },
  },
  list: {
    primitive: 'Mailproof#list', summary: 'newest first; filter by person or date', account: true, positional: '', min: 0, max: 0,
    flags: {
      with: { type: 'string', arg: '<address>', help: 'only emails naming this exact address' },
      role: { type: 'string', arg: '<role>', help: 'narrow --with to from, to, cc or reply-to' },
      direction: { type: 'string', arg: '<in|out>', help: 'only received (in) or sent (out) emails' },
      before: { type: 'string', arg: '<date>', help: 'captured before this date (YYYY-MM-DD, UTC, or a full ISO time)' },
      after: { type: 'string', arg: '<date>', help: 'captured on or after this date' },
      limit: { type: 'string', arg: '<n>', help: 'most rows (default 50, 0 = no cap)' },
    },
  },
  show: {
    primitive: 'Mailproof#get', summary: 'record details', account: true, positional: '<id>', min: 1, max: 1,
    flags: { raw: { type: 'boolean', help: 'print the stored raw email to stdout instead (exit 1 when the content store no longer holds it)' } },
  },
  verify: {
    primitive: 'Mailproof#verify', summary: 're-check one email offline', account: true, positional: '<id>', min: 1, max: 1,
    flags: { at: { type: 'string', arg: '<date>', help: 'judge key and signature expiry as of this time (default: the capture time)' } },
  },
  replies: {
    primitive: 'Mailproof#replyFacts', summary: 'what people answered (by Message-ID)', account: true, positional: '<messageId>', min: 1, max: 1, flags: {},
  },
  check: {
    primitive: 'Mailproof#checkProfile', summary: 'trust profile pass/fail', account: true, positional: '<id>', min: 1, max: 1,
    flags: {
      profile: { type: 'string', arg: '<file|name>', help: 'required: a profile JSON file, or a name looked up as <configDir>/profiles/<name>.json' },
      parent: { type: 'string', arg: '<messageId>', help: 'the request\'s Message-ID, for a profile that requires a link' },
    },
  },
  forget: {
    primitive: 'Mailproof#forget', summary: 'delete stored mail content (destructive)', account: true, positional: '[id ...]', min: 0, max: 1000,
    flags: {
      with: { type: 'string', arg: '<address>', help: 'every stored email with this exact address on From, To or Cc (instead of ids)' },
      before: { type: 'string', arg: '<date>', help: 'with --with: captured before this date' },
      after: { type: 'string', arg: '<date>', help: 'with --with: captured on or after this date' },
      yes: YES, 'dry-run': DRY,
    },
  },
  prune: {
    primitive: 'Mailproof#prune', summary: 'drop old history from the trail (destructive)', account: true, positional: '', min: 0, max: 0,
    flags: {
      before: { type: 'string', arg: '<date>', help: 'required: remove everything captured before this date' },
      yes: YES, 'dry-run': DRY,
      'delete-backup': { type: 'boolean', help: 'remove the <trail>.pre-prune-<date> backup after the swap (the removal is only final then)' },
    },
  },
  backup: {
    summary: 'git bundle of the trail', account: true, positional: '', min: 0, max: 0,
    when: 'Use to keep a copy of the proofs somewhere else. It writes a git bundle of the whole trail (records, keys, replies, stamps; never message bodies) to <state>/backups/<account>/, and prints the path: restore with `git clone <file>.bundle <dir>`. --with-content adds a separate, unencrypted <file>.content.tar of the stored raw emails (other people\'s mail: encrypt it or the disk yourself). --push also pushes the trail to the account\'s backupRemote, never with force: after a prune the remote keeps the history from before it as an archive and the push is refused.',
    fails: 'Exit 1 for an empty trail, a bundle that does not verify, or a missing tar; 64 for a missing --yes with --push or an unconfigured backupRemote; 75 for a push that failed on the network or on a login; 1 for a push the remote rejected.',
    flags: {
      out: { type: 'string', arg: '<path>', help: 'write the bundle here (the directory must exist; an existing file is refused)' },
      'with-content': { type: 'boolean', help: 'also write <file>.content.tar of the content store (the tar binary; not encrypted)' },
      push: { type: 'boolean', help: 'also push the trail to the account\'s backupRemote (no force)' },
      yes: { type: 'boolean', help: 'with --push: confirm the remote is trusted with sender and recipient addresses, subjects and dates' },
    },
  },
  status: {
    summary: 'counts, last sync, storage', account: true, positional: '', min: 0, max: 0, flags: {},
    when: 'Use to see at a glance what a trail holds and how it is kept: records (in and out), oldest and newest capture, last sync, content store size, index state, pending OpenTimestamps stamps, last backup, whether a watch is running. With no --account it lists every account. Read-only: it never connects to the mailbox.',
    fails: 'Exit 0 even for a trail that does not exist yet (it says so).',
  },
  update: {
    summary: 'show the upgrade command', account: false, positional: '', min: 0, max: 0,
    when: 'Use to upgrade mailproof. By default it only prints the command (`npm install -g mailproof@latest`) and the installed version, because a global install can be owned by root or made with another package manager; --run executes it for you.',
    fails: 'With --run the exit code is 0 when npm succeeded and 1 otherwise. Without --run nothing is run and nothing touches the network.',
    flags: { run: { type: 'boolean', help: 'run `npm install -g mailproof@latest` (output streams through)' } },
  },
  config: {
    summary: 'show path, validate, template', account: false, positional: 'path|validate|template|add-account', min: 1, max: 1, flags: {},
    when: 'Use to work with the config file. `path` prints where it is; `validate` checks the permissions and every field without reading any secret (exit 0, 64 or 77); `template` prints an example to start from; `add-account` asks for one account step by step, shows the JSON, and writes it to the file only after you confirm (mode 0600, other accounts kept). The config holds no password: only a command, a file or a token command that yields one.',
    fails: 'validate: 64 for a missing file or a bad field (the message names the JSON path), 77 when the file is not owned by you or is readable by group or others.',
  },
  stamp: {
    primitive: 'Mailproof#stamp', summary: 'seal new mail now (OpenTimestamps)', account: true, positional: '', min: 0, max: 0, flags: {},
  },
  export: {
    summary: 'needs M6 (not available yet)', account: false, positional: '', min: 0, max: 0, flags: {},
    when: 'Reserved for the proof bundle (M6). Not available in this version.', fails: 'Always exits 64.',
  },
  mcp: {
    summary: 'serve the trail to an MCP client (stdio)', account: false, positional: '', min: 0, max: 0,
    when: 'Use to let an AI client (Claude Code, Claude Desktop, any MCP client) read and prove mail through mailproof. It is a stdio server the client starts: register it as `claude mcp add mailproof -- mailproof mcp`. One process serves every account in the config (every account-bound tool takes `account`, required when there are two or more); --account restricts it to one, so a client can give each account its own server and policy. It lists every tool, each with MCP annotations (read-only, destructive, idempotent, open-world) so the client can allow reads and ask a human before the destructive ones; forget and prune only preview until called again with confirm. Paths are read only from the folders in the config `mcp.inputDirs` and files are saved only into `mcp.outputDir`; both are off until you set them. Every write or destructive call adds one line to <state>/mcp.log. Everything an email says reaches the model as untrusted data. stdout carries protocol only and stderr stays silent; --log <file> keeps diagnostics.',
    fails: 'Exit 0 when the client closes stdin or on SIGINT/SIGTERM (calls in flight finish first, up to 5 s; a second signal exits at once), 64 for a bad config, an unknown --account, or a terminal on stdin (it is not an interactive command), 77 when the config file is not private.',
    flags: { log: { type: 'string', arg: '<file>', help: 'append diagnostics to this file (stderr stays silent)' } },
  },
  help: {
    summary: 'this list, or one command', account: false, positional: '[command]', min: 0, max: 1, flags: {},
    when: 'Use to list the commands, or to read one command\'s description, flags and failures.', fails: 'Exit 64 for an unknown command.',
  },
};
