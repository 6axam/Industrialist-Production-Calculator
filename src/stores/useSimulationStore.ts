import { create } from 'zustand';
import { createInitialSimulationState, stepSimulation } from '../simulation/engine';
import type { SimulationState } from '../simulation/types';
import { GAME_TICK_MS } from '../simulation/types';
import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '../types/nodes';

interface SimulationStore extends SimulationState {
  start: (nodes: CanvasNode[], edges: Edge[]) => void;
  stop: () => void;
  reset: (nodes: CanvasNode[], edges: Edge[]) => void;
  tick: (nodes: CanvasNode[], edges: Edge[], deltaMs: number) => void;
}

const emptyState = createInitialSimulationState([], []);
const MAX_CATCH_UP_TICKS = 60;

export const useSimulationStore = create<SimulationStore>((set) => {
  let pendingMs = 0;

  return ({
  ...emptyState,

  start: (nodes, edges) => {
    pendingMs = 0;
    set({ ...createInitialSimulationState(nodes, edges), status: 'running' });
  },

  stop: () => {
    set((state) => ({ status: state.status === 'running' ? 'stopped' : state.status }));
  },

  reset: (nodes, edges) => {
    pendingMs = 0;
    set(createInitialSimulationState(nodes, edges));
  },

  tick: (nodes, edges, deltaMs) => {
    pendingMs += Math.min(1000, Math.max(0, deltaMs));
    set((state) => {
      let nextState: SimulationState = state;
      let ticksProcessed = 0;
      while (pendingMs >= GAME_TICK_MS && ticksProcessed < MAX_CATCH_UP_TICKS) {
        nextState = stepSimulation(nextState, nodes, edges, GAME_TICK_MS);
        pendingMs -= GAME_TICK_MS;
        ticksProcessed += 1;
      }
      if (ticksProcessed === MAX_CATCH_UP_TICKS && pendingMs >= GAME_TICK_MS) {
        pendingMs = 0;
      }
      return nextState;
    });
  },
  });
});
