import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '../types/nodes';

export type SimulationStatus = 'idle' | 'running' | 'stopped' | 'stabilized';

export const GAME_TICK_RATE = 30;
export const GAME_TICK_MS = 1000 / GAME_TICK_RATE;

export interface SimulationNodeState {
  inputBuffers: Record<number, number>;
  cycles: number;
  produced: number;
  blocked: boolean;
  outputRate: number;
  cycleAccumulatorMs: number;
}

export interface SimulationState {
  status: SimulationStatus;
  ticks: number;
  elapsedMs: number;
  nodes: Record<string, SimulationNodeState>;
  edgeBuffers: Record<string, number>;
  recentRates: number[];
  totalOutputRate: number;
  rateWindowMs: number;
  rateWindowProduced: number;
}

export interface SimulationSnapshot {
  nodes: CanvasNode[];
  edges: Edge[];
}
