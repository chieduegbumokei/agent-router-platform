import { describe, expect, it } from 'vitest';
import {
  agentNode,
  applyEvent,
  applyEventToSteps,
  DEFAULT_AGENTS,
  idleRun,
  interruptRun,
  replayRun,
  startRun,
  startSteps,
  synthesizeRecord,
  toolNode,
  type RunRecord,
  type RunState,
} from '../src/lib/pipeline';
import type { StreamEvent } from '../src/lib/types';

const routing: StreamEvent = { type: 'routing', agent: 'coding', reason: 'llm', conversationId: 'c1', userMessageId: 'u1' };

const play = (run: RunState, events: StreamEvent[]) =>
  events.reduce((r, e) => applyEvent(r, e), run);

describe('pipeline run state', () => {
  it('idle: every node pending, not live', () => {
    const run = idleRun(DEFAULT_AGENTS);
    expect(run.live).toBe(false);
    expect(Object.values(run.nodes).every((n) => n.status === 'pending')).toBe(true);
    // graph covers router, 3 agents, their tools, response
    expect(run.nodes['router']).toBeDefined();
    expect(run.nodes[agentNode('coding')]).toBeDefined();
    expect(run.nodes[toolNode('coding', 'code_interpreter')]).toBeDefined();
    expect(run.nodes['response']).toBeDefined();
  });

  it('send: router activates with the message as input', () => {
    const run = startRun(DEFAULT_AGENTS, 'fix my code');
    expect(run.live).toBe(true);
    expect(run.nodes['router']).toMatchObject({ status: 'active', input: 'fix my code' });
  });

  it('routing: router done, chosen agent activates, others stay pending', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'fix my code'), [routing]);
    expect(run.chosenAgent).toBe('coding');
    expect(run.nodes['router']?.status).toBe('done');
    expect(run.nodes['router']?.detail).toContain('LLM classifier');
    expect(run.nodes[agentNode('coding')]?.status).toBe('active');
    expect(run.nodes[agentNode('generic')]?.status).toBe('pending');
    expect(run.nodes[agentNode('financial')]?.status).toBe('pending');
  });

  it('tokens: tick the agent counter and accumulate the response output', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'q'), [
      routing,
      { type: 'token', text: 'Hello ' },
      { type: 'token', text: 'world' },
    ]);
    expect(run.nodes[agentNode('coding')]?.tokens).toBe(2);
    expect(run.nodes['response']?.output).toBe('Hello world');
  });

  it('tool lifecycle: start activates, result completes with captured io', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'q'), [
      routing,
      { type: 'tool_start', tool: 'code_interpreter', input: { code: '1+1' } },
      { type: 'tool_result', tool: 'code_interpreter', ok: true, summary: 'output: 2' },
    ]);
    const tool = run.nodes[toolNode('coding', 'code_interpreter')];
    expect(tool?.status).toBe('done');
    expect(tool?.input).toContain('1+1');
    expect(tool?.output).toBe('output: 2');
  });

  it('failed tool marks the node failed but the run continues', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'q'), [
      routing,
      { type: 'tool_start', tool: 'code_interpreter', input: {} },
      { type: 'tool_result', tool: 'code_interpreter', ok: false, summary: 'timeout' },
    ]);
    expect(run.nodes[toolNode('coding', 'code_interpreter')]?.status).toBe('failed');
    expect(run.live).toBe(true);
  });

  it('done: agent + response complete with usage detail', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'q'), [
      routing,
      { type: 'token', text: 'hi' },
      { type: 'done', messageId: 'm1', usage: { inputTokens: 12, outputTokens: 34 } },
    ]);
    expect(run.live).toBe(false);
    expect(run.nodes[agentNode('coding')]?.status).toBe('done');
    expect(run.nodes['response']?.status).toBe('done');
    expect(run.nodes['response']?.detail).toContain('34 out');
    // real usage is retained on the response node for the Cost tab
    expect(run.nodes['response']?.inputTokens).toBe(12);
    expect(run.nodes['response']?.outputTokens).toBe(34);
  });

  it('error: the active node takes the failure', () => {
    const run = play(startRun(DEFAULT_AGENTS, 'q'), [
      routing,
      { type: 'error', code: 'AGENT_STREAM_FAILED', message: 'stream died' },
    ]);
    expect(run.live).toBe(false);
    expect(run.nodes[agentNode('coding')]?.status).toBe('failed');
    expect(run.nodes['response']?.status).toBe('failed');
  });

  it('interrupt (Stop button): active nodes fail as interrupted', () => {
    const run = interruptRun(play(startRun(DEFAULT_AGENTS, 'q'), [routing]));
    expect(run.live).toBe(false);
    expect(run.nodes[agentNode('coding')]).toMatchObject({ status: 'failed', detail: 'interrupted' });
  });
});

describe('run playback', () => {
  const record: RunRecord = {
    message: 'fix my code',
    startedAt: 1000,
    endedAt: 5000,
    events: [
      { event: routing, at: 1500 },
      { event: { type: 'tool_start', tool: 'code_interpreter', input: { code: '1+1' } }, at: 2000 },
      { event: { type: 'tool_result', tool: 'code_interpreter', ok: true, summary: '2' }, at: 3000 },
      { event: { type: 'token', text: 'done' }, at: 3500 },
      { event: { type: 'done', messageId: 'm1', usage: { inputTokens: 1, outputTokens: 2 } }, at: 4000 },
    ],
  };

  it('cursor 0: only the router is active (run just started)', () => {
    const run = replayRun(DEFAULT_AGENTS, record, 0);
    expect(run.nodes['router']?.status).toBe('active');
    expect(run.chosenAgent).toBeUndefined();
  });

  it('mid-run cursor: state matches the live run at that point', () => {
    const run = replayRun(DEFAULT_AGENTS, record, 2);
    expect(run.nodes['router']?.status).toBe('done');
    expect(run.nodes[toolNode('coding', 'code_interpreter')]?.status).toBe('active');
    expect(run.live).toBe(true);
  });

  it('full replay: reaches the terminal state with recorded timings', () => {
    const run = replayRun(DEFAULT_AGENTS, record, record.events.length);
    expect(run.live).toBe(false);
    expect(run.nodes['response']?.status).toBe('done');
    expect(run.nodes['router']?.startedAt).toBe(1000);
  });

  it('interrupted record: full replay ends with active nodes failed', () => {
    const cut: RunRecord = { ...record, interrupted: true, events: record.events.slice(0, 2) };
    const run = replayRun(DEFAULT_AGENTS, cut, 2);
    expect(run.live).toBe(false);
    expect(run.nodes[toolNode('coding', 'code_interpreter')]).toMatchObject({
      status: 'failed',
      detail: 'interrupted',
    });
  });

  it('synthesizeRecord: history message becomes a replayable record', () => {
    const rec = synthesizeRecord('please compute', {
      content: 'The answer is 2.',
      agentId: 'coding',
      toolCalls: [{ tool: 'code_interpreter', ok: true, summary: '2' }],
    });
    expect(rec).not.toBeNull();
    const run = replayRun(DEFAULT_AGENTS, rec!, rec!.events.length);
    expect(run.nodes[toolNode('coding', 'code_interpreter')]?.status).toBe('done');
    expect(run.nodes['response']).toMatchObject({ status: 'done' });
    expect(run.nodes['response']?.output).toBe('The answer is 2.');
  });

  it('synthesizeRecord: unrouted message is not replayable', () => {
    expect(synthesizeRecord('q', { content: 'hi' })).toBeNull();
  });
});

describe('chat activity steps', () => {
  const play = (events: StreamEvent[]) =>
    events.reduce((s, e) => applyEventToSteps(s, e, DEFAULT_AGENTS), startSteps());

  it('starts with routing running', () => {
    expect(startSteps()).toMatchObject([{ id: 'route', status: 'running' }]);
  });

  it('routing: route done, agent thinking with a pointer-worthy running step', () => {
    const steps = play([routing]);
    expect(steps[0]).toMatchObject({ id: 'route', status: 'done' });
    expect(steps[0].detail).toContain('Coding Agent');
    expect(steps[1]).toMatchObject({ kind: 'think', status: 'running' });
  });

  it('first token flips thinking into writing', () => {
    const steps = play([routing, { type: 'token', text: 'hi' }]);
    expect(steps[1]).toMatchObject({ kind: 'write', label: 'Writing response', status: 'running' });
  });

  it('tool lifecycle inserts a tool step and resumes writing', () => {
    const steps = play([
      routing,
      { type: 'tool_start', tool: 'code_interpreter', input: { code: '1+1' } },
      { type: 'tool_result', tool: 'code_interpreter', ok: true, summary: 'output: 2' },
    ]);
    const tool = steps.find((s) => s.kind === 'tool');
    expect(tool).toMatchObject({ label: 'Using code_interpreter', status: 'done' });
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'write', status: 'running' });
  });

  it('done completes every running step; error fails it', () => {
    const done = play([routing, { type: 'done', messageId: 'm', usage: { inputTokens: 1, outputTokens: 1 } }]);
    expect(done.every((s) => s.status === 'done')).toBe(true);
    const failed = play([routing, { type: 'error', code: 'X', message: 'boom' }]);
    expect(failed[failed.length - 1]).toMatchObject({ status: 'failed', detail: 'boom' });
  });
});
