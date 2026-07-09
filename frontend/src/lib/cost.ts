import type { RunState } from './pipeline';

/**
 * Token accounting + cost estimation for the pipeline inspector's Cost tab.
 *
 * The chat stream only reports one real usage figure — the prompt/completion
 * token counts for the answering agent, delivered on the terminal `done` event
 * (stored on the `response` node). The router's short classification call runs
 * on a separate, cheaper model and is not metered by the stream, and tool
 * stages don't call the model at all. `costForNode` reflects that honestly.
 */

/** USD per 1M tokens. Mirrors the models in backend/src/core/config.ts. */
export interface ModelPrice {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

// Router → Claude Haiku 4.5; agents → Claude Sonnet 4.5.
export const ROUTER_MODEL: ModelPrice = { model: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 };
export const AGENT_MODEL: ModelPrice = { model: 'Claude Sonnet 4.5', inputPerMTok: 3, outputPerMTok: 15 };

export interface NodeCost {
  /** Model this stage runs on. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** False until real usage has been reported (or when a stage isn't metered). */
  metered: boolean;
  /** Where the numbers come from, or why they're absent. */
  note: string;
}

const money = (tokens: number, perMTok: number) => (tokens / 1_000_000) * perMTok;

/** Format a USD amount; per-request costs are tiny, so keep sub-cent precision. */
export function fmtUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(4)}`;
}

/** Token usage and estimated cost attributable to the selected node. */
export function costForNode(nodeId: string, run: RunState): NodeCost | null {
  const resp = run.nodes['response'];
  const inputTokens = resp?.inputTokens ?? 0;
  const outputTokens = resp?.outputTokens ?? 0;
  const metered = inputTokens > 0 || outputTokens > 0;

  // The agent's generation is what the `done` usage measures; the response is
  // that same generation assembled, so both attribute to the agent model.
  if (nodeId === 'response' || nodeId.startsWith('agent:')) {
    const p = AGENT_MODEL;
    const inputCost = money(inputTokens, p.inputPerMTok);
    const outputCost = money(outputTokens, p.outputPerMTok);
    return {
      model: p.model,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      metered,
      note: metered
        ? 'Prompt and completion tokens reported for this run, priced at published per-million-token rates.'
        : 'Token usage is reported once the response finishes streaming.',
    };
  }

  if (nodeId === 'router') {
    return {
      model: ROUTER_MODEL.model,
      inputTokens: 0,
      outputTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      metered: false,
      note: 'The router runs a short forced-tool classification on Claude Haiku. Its token usage is not reported separately by the stream.',
    };
  }

  // Tool stages invoke an external tool, not the model — no model tokens.
  return null;
}
