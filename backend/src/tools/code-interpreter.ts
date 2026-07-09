import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config';
import type { Tool, ToolResult } from '../core/types';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-runner.cjs');

interface RunnerReply {
  ok: boolean;
  output: string;
  error: string | null;
}

export function runCode(code: string, timeoutMs = config.codeTimeoutMs): Promise<ToolResult> {
  return new Promise((resolve) => {
    // env: {} - the child never sees API keys or AWS credentials
    const child = fork(RUNNER, [], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(result);
    };

    const killer = setTimeout(
      () => settle({ ok: false, content: `execution timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );

    child.on('message', (msg) => {
      clearTimeout(killer);
      const { ok, output, error } = msg as RunnerReply;
      settle({
        ok,
        content: ok
          ? `output:\n${output || '(no output)'}`
          : `error: ${error ?? 'unknown'}\noutput:\n${output || '(none)'}`,
      });
    });
    child.on('error', () => {
      clearTimeout(killer);
      settle({ ok: false, content: 'sandbox failed to start' });
    });
    child.on('exit', () => {
      clearTimeout(killer);
      settle({ ok: false, content: 'sandbox exited unexpectedly' });
    });

    child.send({ code });
  });
}

export const codeInterpreterTool: Tool = {
  name: 'code_interpreter',
  description:
    'Execute JavaScript in a sandbox and get its console output. Use to verify code, compute results, or demonstrate behavior. No require/imports, no network, no filesystem; 5 second limit.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript source to execute' },
    },
    required: ['code'],
  },

  async execute(input) {
    const code = typeof input === 'object' && input !== null ? String((input as Record<string, unknown>).code ?? '') : '';
    if (!code) return { ok: false, content: 'no code provided' };
    return runCode(code);
  },
};
