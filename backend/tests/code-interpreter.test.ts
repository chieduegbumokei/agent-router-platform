import { describe, expect, it } from 'vitest';
import { runCode } from '../src/tools/code-interpreter';

describe('code interpreter sandbox', () => {
  it('runs code and captures console output', async () => {
    const res = await runCode('console.log(6 * 7)');
    expect(res.ok).toBe(true);
    expect(res.content).toContain('42');
  });

  it('returns the final expression value', async () => {
    const res = await runCode('[1,2,3].map(x => x * 2)');
    expect(res.ok).toBe(true);
    expect(res.content).toContain('[2,4,6]');
  });

  it('reports runtime errors without crashing', async () => {
    const res = await runCode('null.foo');
    expect(res.ok).toBe(false);
    expect(res.content).toContain('error');
  });

  it('blocks require/module access', async () => {
    const res = await runCode('require("fs").readFileSync("/etc/passwd")');
    expect(res.ok).toBe(false);
  });

  it('blocks process access (no env leakage)', async () => {
    const res = await runCode('console.log(process.env)');
    expect(res.ok).toBe(false);
  });

  it('kills infinite loops via timeout', async () => {
    const res = await runCode('while (true) {}', 1500);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/timed out|error/);
  }, 10000);
});
