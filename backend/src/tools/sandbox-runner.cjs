'use strict';
/**
 * Code-interpreter sandbox child. Receives { code } over IPC, runs it in a
 * bare `vm` context (no require/import/process/fs/network primitives), captures
 * console output, replies { ok, output, error } and exits.
 *
 * NOT a production security boundary (vm is escapable by determined code) -
 * defense in depth: empty env, parent-side hard kill, output cap. Production
 * would use Firecracker / per-execution Lambda (documented in docs/LLD.md §8.2).
 */
const vm = require('node:vm');

const OUTPUT_CAP = 64 * 1024;

process.on('message', (msg) => {
  const code = msg && typeof msg.code === 'string' ? msg.code : '';
  const lines = [];
  const push = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '));
  };

  const sandbox = {
    console: { log: push, error: push, warn: push, info: push },
    Math,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    setTimeout: undefined, // no timers → no async escape hatches
    require: undefined,
    process: undefined,
    module: undefined,
  };

  const finish = (ok, error) => {
    let output = lines.join('\n');
    if (output.length > OUTPUT_CAP) output = output.slice(0, OUTPUT_CAP) + '\n...[output truncated]';
    process.send({ ok, output, error: error || null }, () => process.exit(0));
  };

  try {
    // `timeout` kills synchronous infinite loops; the parent hard-kills the
    // process as a backstop for anything else.
    const result = vm.runInNewContext(code, sandbox, { timeout: 4000 });
    Promise.resolve(result)
      .then((value) => {
        if (value !== undefined) push(safeStringify(value));
        finish(true);
      })
      .catch((err) => finish(false, String(err && err.message ? err.message : err)));
  } catch (err) {
    finish(false, String(err && err.message ? err.message : err));
  }
});

function safeStringify(value) {
  try {
    return typeof value === 'undefined' ? 'undefined' : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
