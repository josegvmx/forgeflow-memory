import { ingestEvent } from '../ingest/pipeline.js';
import type { ReasoningEvent } from '../types.js';

// ============================================================
// Audit Event Types
// Extended versions of ReasoningEvent with richer metadata
// specific to scenario-audit (failures, adjustments, recovery).
// ============================================================

export interface MachineFailureEvent {
  scenarioId: string;
  nodeId: string;
  cycle: number;
  mode: 'heuristic' | 'ai';
  content: string;
  metadata: {
    machineId: string;
    failureType: 'breakdown' | 'maintenance' | 'capacity_reduction';
    affectedCapacity: number;       // percentage lost
    affectedProducts: string[];
    cycleOfRecovery?: number;       // filled in later when machine recovers
  };
}

export interface RoutingAdjustmentEvent {
  scenarioId: string;
  nodeId: string;
  cycle: number;
  mode: 'heuristic' | 'ai';
  content: string;
  metadata: {
    triggeredByFailure: string;     // machineId that caused this
    fromMachine: string;
    toMachine: string;
    productsRerouted: string[];
    throughputBefore: number;
    throughputAfter: number;
    decisionLatencyCycles: number;  // cycles before adjustment was made
  };
}

export interface RecoveryOutcomeEvent {
  scenarioId: string;
  nodeId: string;
  cycle: number;
  mode: 'heuristic' | 'ai';
  content: string;
  metadata: {
    machineId: string;
    cyclesDowntime: number;
    productionLost: number;         // units
    recoveryStrategy: string;       // what the agent did
    successful: boolean;
  };
}

export type AuditEvent =
  | MachineFailureEvent
  | RoutingAdjustmentEvent
  | RecoveryOutcomeEvent;

// ============================================================
// Ingest helpers
// Map each audit event type to a ReasoningEvent and store it.
// ============================================================

function machineFailureToReasoningEvent(e: MachineFailureEvent): ReasoningEvent {
  return {
    scenarioId: e.scenarioId,
    nodeId: e.nodeId,
    cycle: e.cycle,
    eventType: 'machine_failure',
    mode: e.mode,
    content: e.content,
    metadata: e.metadata,
  };
}

function routingAdjustmentToReasoningEvent(e: RoutingAdjustmentEvent): ReasoningEvent {
  return {
    scenarioId: e.scenarioId,
    nodeId: e.nodeId,
    cycle: e.cycle,
    eventType: 'routing_adjustment',
    mode: e.mode,
    content: e.content,
    metadata: e.metadata,
  };
}

function recoveryOutcomeToReasoningEvent(e: RecoveryOutcomeEvent): ReasoningEvent {
  return {
    scenarioId: e.scenarioId,
    nodeId: e.nodeId,
    cycle: e.cycle,
    eventType: 'recovery',
    mode: e.mode,
    content: e.content,
    metadata: e.metadata,
  };
}

/**
 * Ingest any audit event into the memory layer.
 * Automatically maps to the correct ReasoningEvent shape.
 */
export async function ingestAuditEvent(event: AuditEvent): Promise<void> {
  let reasoningEvent: ReasoningEvent;

  if ('metadata' in event && 'failureType' in event.metadata) {
    reasoningEvent = machineFailureToReasoningEvent(event as MachineFailureEvent);
  } else if ('metadata' in event && 'triggeredByFailure' in event.metadata) {
    reasoningEvent = routingAdjustmentToReasoningEvent(event as RoutingAdjustmentEvent);
  } else {
    reasoningEvent = recoveryOutcomeToReasoningEvent(event as RecoveryOutcomeEvent);
  }

  await ingestEvent(reasoningEvent);
}
