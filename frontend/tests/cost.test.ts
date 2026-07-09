import { describe, expect, it } from 'vitest';
import { applyEvent, startRun, DEFAULT_AGENTS, agentNode, type RunState } from '../src/lib/pipeline';
import { costForNode, fmtUsd } from '../src/lib/cost';
import type { StreamEvent } from '../src/lib/types';

const routing: StreamEvent = { type: 'routing', agent: 'coding', reason: 'llm', conversationId: 'c', userMessageId: 'u' };

function finished(inputTokens: number, outputTokens: number): RunState {
  const events: StreamEvent[] = [routing, { type: 'done', messageId: 'm', usage: { inputTokens, outputTokens } }];
  return events.reduce((r, e) => applyEvent(r, e, 0), startRun(DEFAULT_AGENTS, 'q', 0));
}

describe('costForNode', () => {
  it('prices the response node at Sonnet rates from the real usage', () => {
    const run = finished(1000, 500);
    const cost = costForNode('response', run)!;
    expect(cost.metered).toBe(true);
    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(500);
    // 1000/1e6 * $3 + 500/1e6 * $15 = 0.003 + 0.0075
    expect(cost.inputCost).toBeCloseTo(0.003, 10);
    expect(cost.outputCost).toBeCloseTo(0.0075, 10);
    expect(cost.totalCost).toBeCloseTo(0.0105, 10);
    expect(cost.model).toContain('Sonnet');
  });

  it('attributes the same run usage to the chosen agent node', () => {
    const run = finished(200, 100);
    const cost = costForNode(agentNode('coding'), run)!;
    expect(cost.inputTokens).toBe(200);
    expect(cost.outputTokens).toBe(100);
  });

  it('marks the response node unmetered before the run completes', () => {
    const run = applyEvent(startRun(DEFAULT_AGENTS, 'q', 0), routing, 0);
    const cost = costForNode('response', run)!;
    expect(cost.metered).toBe(false);
    expect(cost.totalCost).toBe(0);
  });

  it('flags the router as running Haiku but not separately metered', () => {
    const cost = costForNode('router', finished(1000, 500))!;
    expect(cost.metered).toBe(false);
    expect(cost.model).toContain('Haiku');
  });

  it('returns null for tool stages (no model tokens)', () => {
    expect(costForNode('tool:coding:code_interpreter', finished(1000, 500))).toBeNull();
  });
});

describe('fmtUsd', () => {
  it('formats zero, sub-cent, and larger amounts', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.001234)).toBe('$0.001234'); // sub-cent (< $0.01): 6-decimal precision
    expect(fmtUsd(0.0105)).toBe('$0.0105'); // above a cent: 4-decimal precision
    expect(fmtUsd(1.5)).toBe('$1.5000');
  });
});
