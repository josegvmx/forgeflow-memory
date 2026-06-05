// ============================================================
// Shared domain types for forgeflow-memory
// ============================================================

export interface ReasoningEvent {
  scenarioId: string;
  nodeId: string;
  cycle: number;
  eventType: 'machine_failure' | 'routing_adjustment' | 'decision' | 'coalition';
  mode: 'heuristic' | 'ai';
  /** Human-readable description — this is what gets embedded */
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  scenarioId?: string;
  nodeId?: string;
  /** Natural language question / context string */
  context: string;
  topK: number;
  eventTypeFilter?: ReasoningEvent['eventType'][];
}

export interface MemoryResult {
  events: ReasoningEvent[];
  /** Claude-synthesized recommendation based on retrieved events */
  summary: string;
}
