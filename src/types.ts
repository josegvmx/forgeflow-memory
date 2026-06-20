// ============================================================
// Shared domain types for forgeflow-memory
// ============================================================

export interface ReasoningEvent {
  scenarioId: string;
  nodeId: string;
  cycle: number;
  eventType: 'machine_failure' | 'routing_adjustment' | 'decision' | 'coalition' | 'recovery';
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
  /**
   * When true, the result includes _debugContext — the raw formatted string
   * passed to the LLM. Used by the eval pipeline to run faithfulness checks.
   */
  debug?: boolean;
}

export interface MemoryResult {
  events: ReasoningEvent[];
  /** Claude-synthesized recommendation based on retrieved events */
  summary: string;
  /**
   * Only populated when query.debug === true.
   * Contains the formatted context string sent to the synthesis LLM.
   */
  _debugContext?: string;
}
