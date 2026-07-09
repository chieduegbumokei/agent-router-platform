'use client';

import { ChevronsLeft, ChevronsRight, Pause, Play, Radio, RotateCcw, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { explainNode } from '@/lib/explanations';
import { costForNode, fmtUsd } from '@/lib/cost';
import ReactFlow, {
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from 'reactflow';
import {
  agentNode,
  fmtDuration,
  playbackDelay,
  replayRun,
  type AgentMeta,
  type RunRecord,
  type RunState,
  type StageInfo,
} from '@/lib/pipeline';

/* ---- custom node: Milgo .pnode card ---- */

interface PnodeData {
  badge: string;
  label: string;
  stage: StageInfo;
  selected: boolean;
}

const Pnode = memo(function Pnode({ data }: NodeProps<PnodeData>) {
  const { badge, label, stage, selected } = data;
  return (
    <div className={`pnode ${stage.status}${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="pnode-head">
        <span className="pnode-badge">{badge}</span>
        <span className={`pnode-dot ${stage.status}`} />
      </div>
      <div className="pnode-label">{label}</div>
      <div className={`pnode-detail${stage.detail ? '' : ' muted'}`}>
        {stage.detail ?? 'waiting'}
        {stage.endedAt && stage.startedAt ? ` · ${fmtDuration(stage)}` : ''}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { pnode: Pnode };

/* ---- layout: only the path this run actually takes, as one vertical flow:
        router → chosen agent → each tool it invoked → response ---- */

const ROW_H = 118;

function buildGraph(agents: AgentMeta[], run: RunState, selectedId: string | null) {
  const stage = (id: string): StageInfo => run.nodes[id] ?? { status: 'pending' };

  const chain: { id: string; badge: string; label: string }[] = [
    { id: 'router', badge: 'RTR', label: 'Router Agent' },
  ];

  if (run.chosenAgent) {
    const meta = agents.find((a) => a.id === run.chosenAgent);
    chain.push({
      id: agentNode(run.chosenAgent),
      badge: run.chosenAgent.slice(0, 3).toUpperCase(),
      label: meta?.displayName ?? run.chosenAgent,
    });
    // Tools the agent actually invoked, in call order - built-in (web_search,
    // code_interpreter) and per-user MCP connector tools alike. MCP tools
    // aren't in the static agent registry, so toolOrder (populated live from
    // tool_start events) is the only complete source for this list.
    const prefix = `tool:${run.chosenAgent}:`;
    for (const tid of run.toolOrder) {
      if (!tid.startsWith(prefix) || stage(tid).status === 'pending') continue;
      const toolName = tid.slice(prefix.length);
      const isMcp = toolName.startsWith('mcp_');
      chain.push({
        id: tid,
        badge: isMcp ? 'MCP' : 'TOOL',
        label: isMcp ? toolName.slice(4).replace(/_/g, ' ') : toolName,
      });
    }
  }

  chain.push({ id: 'response', badge: 'OUT', label: 'Streamed Response' });

  const nodes: Node<PnodeData>[] = chain.map((c, i) => ({
    id: c.id,
    type: 'pnode',
    position: { x: 0, y: i * ROW_H },
    draggable: false,
    connectable: false,
    data: { badge: c.badge, label: c.label, stage: stage(c.id), selected: selectedId === c.id },
  }));

  const edges: Edge[] = chain.slice(1).map((c, i) => {
    const source = chain[i].id;
    const active = stage(c.id).status === 'active' || (c.id === 'response' && run.live);
    const onPath = stage(c.id).status !== 'pending' || active;
    return {
      id: `${source}-${c.id}`,
      source,
      target: c.id,
      animated: active,
      style: onPath ? { stroke: 'var(--accent)', strokeWidth: 2 } : { stroke: '#d9dee6' },
    };
  });

  return { nodes, edges };
}

/* ---- panel ---- */

const NODE_LABELS: Record<string, string> = {
  router: 'Router Agent',
  response: 'Streamed Response',
};

interface Props {
  agents: AgentMeta[];
  run: RunState;
  open: boolean;
  onClose(): void;
  /** When set, the panel replays this recorded run instead of the live one. */
  playback?: RunRecord | null;
  onExitPlayback?(): void;
}

const WIDTH_KEY = 'pipeline.width';
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 420;

/** Refit the viewport whenever the set of nodes on the path changes. */
function AutoFit({ nodeCount }: { nodeCount: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.15, duration: 250 }));
    return () => cancelAnimationFrame(id);
  }, [nodeCount, fitView]);
  return null;
}

export function PipelinePanel({ agents, run, open, onClose, playback, onExitPlayback }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'explain' | 'data' | 'cost'>('explain');
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  /* ---- playback cursor ---- */
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = playback?.events.length ?? 0;

  // a new record starts playing from the top
  useEffect(() => {
    setCursor(0);
    setPlaying(Boolean(playback));
    if (playback) setCollapsed(false);
  }, [playback]);

  // auto-advance while playing
  useEffect(() => {
    if (!playing || !playback) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCursor((c) => c + 1), playbackDelay(playback, cursor));
    return () => clearTimeout(t);
  }, [playing, playback, cursor, total]);

  const shownRun = useMemo(
    () => (playback ? replayRun(agents, playback, cursor) : run),
    [playback, agents, cursor, run],
  );

  const { nodes, edges } = useMemo(
    () => buildGraph(agents, shownRun, selectedId),
    [agents, shownRun, selectedId],
  );

  // fresh node selection starts on the Explanation tab
  useEffect(() => setTab('explain'), [selectedId]);

  // opening the mobile drawer always shows the full panel
  useEffect(() => {
    if (open) setCollapsed(false);
  }, [open]);

  // restore the persisted panel width
  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= MIN_WIDTH) setWidth(saved);
  }, []);

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    const panel = panelRef.current;
    if (!panel) return;
    // cap at half the layout row, so the panel never outgrows the chat pane (flex: 1)
    const max = Math.floor((panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth) / 2);
    const next = Math.round(panel.getBoundingClientRect().right - e.clientX);
    setWidth(Math.min(max, Math.max(MIN_WIDTH, next)));
  }
  function onResizeEnd() {
    if (!resizing) return;
    setResizing(false);
    setWidth((w) => {
      localStorage.setItem(WIDTH_KEY, String(w));
      return w;
    });
  }

  const selected = selectedId ? shownRun.nodes[selectedId] : undefined;
  const overall = playback
    ? 'playback'
    : shownRun.live
      ? 'running'
      : Object.values(shownRun.nodes).some((n) => n.status === 'failed')
        ? 'failed'
        : shownRun.nodes['response']?.status === 'done'
          ? 'completed'
          : 'idle';

  if (collapsed) {
    return (
      <aside className={`pipeline-panel collapsed${open ? ' open' : ''}`}>
        <button
          className="pipeline-expand"
          onClick={() => setCollapsed(false)}
          aria-label="Expand pipeline"
          title="Expand pipeline"
        >
          <ChevronsLeft size={16} />
          <span className={`status-dot ${overall}`} />
          <span className="pipeline-expand-label">Live pipeline</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      className={`pipeline-panel${open ? ' open' : ''}${resizing ? ' resizing' : ''}`}
      style={{ width }}
    >
      <div
        className="pipeline-resizer"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pipeline panel"
      />
      <div className="pipeline-head">
        <h2>{playback ? 'Run playback' : 'Live pipeline'}</h2>
        <div className="pipeline-head-right">
          <span className={`pill status ${overall}`}>
            <span className="status-dot" />
            {overall}
          </span>
          <button
            className="icon-btn pipeline-collapse"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse pipeline"
            title="Collapse pipeline"
          >
            <ChevronsRight size={15} />
          </button>
          <button className="icon-btn pipeline-close" onClick={onClose} aria-label="Close pipeline">
            <X size={15} />
          </button>
        </div>
      </div>

      {playback && (
        <div className="playback-bar">
          <button
            className="icon-btn playback-btn"
            onClick={() => {
              if (cursor >= total) setCursor(0);
              setPlaying((p) => !p);
            }}
            aria-label={playing ? 'Pause playback' : 'Play playback'}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            className="icon-btn playback-btn"
            onClick={() => {
              setCursor(0);
              setPlaying(true);
            }}
            aria-label="Restart playback"
            title="Restart"
          >
            <RotateCcw size={13} />
          </button>
          <input
            className="playback-scrub"
            type="range"
            min={0}
            max={total}
            value={cursor}
            onChange={(e) => {
              setPlaying(false);
              setCursor(Number(e.target.value));
            }}
            aria-label="Playback position"
          />
          <span className="playback-count">
            {cursor}/{total}
          </span>
          <button className="btn sm secondary playback-live" onClick={onExitPlayback}>
            <Radio size={13} />
            Live
          </button>
        </div>
      )}

      <div className="pipeline-canvas">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            zoomOnScroll={false}
            panOnDrag
            preventScrolling={false}
            onNodeClick={(_e, node) => setSelectedId((cur) => (cur === node.id ? null : node.id))}
            onPaneClick={() => setSelectedId(null)}
          >
            <AutoFit nodeCount={nodes.length} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      {selectedId && selected && (
        <div className="pipeline-inspector">
          <div className="pipeline-inspector-head">
            <strong>{labelFor(selectedId, agents)}</strong>
            <span className={`status-pill ${selected.status}`}>{selected.status}</span>
            {fmtDuration(selected) && <span className="text-meta">{fmtDuration(selected)}</span>}
          </div>

          <div className="subnav">
            <button className={tab === 'explain' ? 'active' : ''} onClick={() => setTab('explain')}>
              Explanation
            </button>
            <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>
              Data
            </button>
            <button className={tab === 'cost' ? 'active' : ''} onClick={() => setTab('cost')}>
              Cost
            </button>
          </div>

          {tab === 'explain' && <p className="node-explain">{explainNode(selectedId, agents)}</p>}

          {tab === 'data' && (
            <>
              {selected.input && (
                <div className="io-block">
                  <div className="io-label">Input</div>
                  <pre className="io-pre">{selected.input}</pre>
                </div>
              )}
              {selected.output && (
                <div className="io-block">
                  <div className="io-label">Output</div>
                  <pre className="io-pre">{selected.output}</pre>
                </div>
              )}
              {!selected.input && !selected.output && (
                <div className="text-meta">No input/output captured for this stage yet.</div>
              )}
            </>
          )}

          {tab === 'cost' && <CostTab nodeId={selectedId} run={shownRun} />}
        </div>
      )}
    </aside>
  );
}

/** Cost tab: token usage and estimated USD cost for the selected stage. */
function CostTab({ nodeId, run }: { nodeId: string; run: RunState }) {
  const cost = costForNode(nodeId, run);
  if (!cost) {
    return (
      <p className="node-explain">
        This stage invokes an external tool rather than the language model, so it doesn’t consume model
        tokens directly.
      </p>
    );
  }
  const totalTokens = cost.inputTokens + cost.outputTokens;
  return (
    <div className="cost-view">
      <div className="cost-model">{cost.model}</div>
      {cost.metered && (
        <>
          <div className="cost-grid">
            <div className="cost-row">
              <span>Input tokens</span>
              <span>{cost.inputTokens.toLocaleString()}</span>
            </div>
            <div className="cost-row">
              <span>Output tokens</span>
              <span>{cost.outputTokens.toLocaleString()}</span>
            </div>
            <div className="cost-row total">
              <span>Total tokens</span>
              <span>{totalTokens.toLocaleString()}</span>
            </div>
          </div>
          <div className="cost-grid">
            <div className="cost-row">
              <span>Input cost</span>
              <span>{fmtUsd(cost.inputCost)}</span>
            </div>
            <div className="cost-row">
              <span>Output cost</span>
              <span>{fmtUsd(cost.outputCost)}</span>
            </div>
            <div className="cost-row total">
              <span>Estimated cost</span>
              <span>{fmtUsd(cost.totalCost)}</span>
            </div>
          </div>
        </>
      )}
      <p className="cost-note">{cost.note}</p>
    </div>
  );
}

function labelFor(nodeId: string, agents: AgentMeta[]): string {
  if (NODE_LABELS[nodeId]) return NODE_LABELS[nodeId];
  if (nodeId.startsWith('agent:')) {
    const id = nodeId.slice('agent:'.length);
    return agents.find((a) => a.id === id)?.displayName ?? id;
  }
  if (nodeId.startsWith('tool:')) {
    const tool = nodeId.split(':')[2] ?? nodeId;
    return tool.startsWith('mcp_') ? tool.slice(4).replace(/_/g, ' ') : tool;
  }
  return nodeId;
}
