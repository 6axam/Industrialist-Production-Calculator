import type { Edge } from '@xyflow/react';
import { resolveActiveRecipe } from '../data/lookup';
import type { Recipe } from '../types/data';
import { isRecipeNode, type CanvasNode } from '../types/nodes';
import { parseHandleId } from '../utils/idGenerator';
import { createGraphResolutionContext } from '../utils/graphResolutionContext';
import type { SimulationNodeState, SimulationState } from './types';

const STABILIZATION_SAMPLE_COUNT = 10;
const STABILIZATION_TOLERANCE = 0.02;
const MAX_CYCLES_PER_STEP = 120;
const CYCLE_TIME_EPSILON_MS = 0.000001;

function getNodeRecipe(
  node: { data: { recipeId: string; settings?: Record<string, unknown> }; id: string },
  helpers: ReturnType<ReturnType<typeof createGraphResolutionContext>['createHelpers']>,
): Recipe | undefined {
  return resolveActiveRecipe(node.data.recipeId, node.data.settings, node.id, helpers);
}

function getScaledQuantity(
  quantity: number,
  machineCount: number,
  independentOfMachineCount: boolean | undefined,
): number {
  return quantity * (independentOfMachineCount ? 1 : machineCount);
}

function createNodeState(
  node: { data: { recipeId: string; settings?: Record<string, unknown> }; id: string },
  helpers: ReturnType<ReturnType<typeof createGraphResolutionContext>['createHelpers']>,
): SimulationNodeState {
  const recipe = getNodeRecipe(node, helpers);
  const inputBuffers: Record<number, number> = {};
  for (let i = 0; i < (recipe?.inputs.length ?? 0); i++) inputBuffers[i] = 0;
  return { inputBuffers, cycles: 0, produced: 0, blocked: false, outputRate: 0, cycleAccumulatorMs: 0 };
}

export function createInitialSimulationState(nodes: CanvasNode[], edges: Edge[]): SimulationState {
  const recipeNodes = nodes.filter(isRecipeNode);
  const resolutionContext = createGraphResolutionContext(recipeNodes, edges);
  const nodeStates: Record<string, SimulationNodeState> = {};
  for (const node of nodes) {
    if (isRecipeNode(node)) {
      nodeStates[node.id] = createNodeState(node, resolutionContext.createHelpers(node.id));
    }
  }

  const edgeBuffers: Record<string, number> = {};
  for (const edge of edges) edgeBuffers[edge.id] = 0;

  return {
    status: 'idle',
    ticks: 0,
    elapsedMs: 0,
    nodes: nodeStates,
    edgeBuffers,
    recentRates: [],
    totalOutputRate: 0,
    rateWindowMs: 0,
    rateWindowProduced: 0,
  };
}

function deliverEdgeBuffers(state: SimulationState, edges: Edge[]): void {
  for (const edge of edges) {
    const amount = state.edgeBuffers[edge.id] ?? 0;
    if (amount <= 0 || !edge.targetHandle) continue;
    const target = state.nodes[edge.target];
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!target || !targetHandle || targetHandle.side !== 'input') continue;
    target.inputBuffers[targetHandle.index] = (target.inputBuffers[targetHandle.index] ?? 0) + amount;
    state.edgeBuffers[edge.id] = 0;
  }
}

function deliverOutput(
  state: SimulationState,
  edges: Edge[],
  sourceNodeId: string,
  outputIndex: number,
  amount: number,
  remainingCycles: Map<string, number>,
  queue: string[],
): void {
  const sourceHandle = `${sourceNodeId}-output-${outputIndex}`;
  for (const edge of edges) {
    if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandle) continue;
    state.edgeBuffers[edge.id] = (state.edgeBuffers[edge.id] ?? 0) + amount;
    if (!edge.targetHandle) continue;
    const target = state.nodes[edge.target];
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!target || !targetHandle || targetHandle.side !== 'input') continue;
    target.inputBuffers[targetHandle.index] =
      (target.inputBuffers[targetHandle.index] ?? 0) + amount;
    state.edgeBuffers[edge.id] = 0;
    if ((remainingCycles.get(edge.target) ?? 0) > 0) queue.push(edge.target);
  }
}

function getTotalProduced(state: SimulationState): number {
  return Object.values(state.nodes).reduce((total, node) => total + node.produced, 0);
}

function isSelfLoopInput(edge: Edge, nodeId: string, inputIndex: number): boolean {
  if (edge.source !== nodeId || edge.target !== nodeId) return false;
  const targetHandle = edge.targetHandle ? parseHandleId(edge.targetHandle) : null;
  return targetHandle?.side === 'input' && targetHandle.index === inputIndex;
}

export function stepSimulation(
  previous: SimulationState,
  nodes: CanvasNode[],
  edges: Edge[],
  deltaMs: number,
): SimulationState {
  if (previous.status !== 'running' || deltaMs <= 0) return previous;

  const state: SimulationState = {
    ...previous,
    ticks: previous.ticks + 1,
    elapsedMs: previous.elapsedMs + deltaMs,
    nodes: Object.fromEntries(
      Object.entries(previous.nodes).map(([id, node]) => [id, { ...node, inputBuffers: { ...node.inputBuffers } }]),
    ),
    edgeBuffers: { ...previous.edgeBuffers },
    recentRates: [...previous.recentRates],
  };
  const previousProduced = getTotalProduced(previous);
  deliverEdgeBuffers(state, edges);
  const recipeNodes = nodes.filter(isRecipeNode);
  const resolutionContext = createGraphResolutionContext(recipeNodes, edges);

  const recipes = new Map<string, Recipe>();
  const remainingCycles = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if (!isRecipeNode(node)) continue;
    const recipe = getNodeRecipe(node, resolutionContext.createHelpers(node.id));
    const runtime = state.nodes[node.id];
    if (!recipe || !runtime || node.data.machineCount <= 0) continue;

    const cycleTimeMs = Math.max(1, recipe.cycle_time * 1000);
    const previousAccumulator = runtime.cycleAccumulatorMs;
    const cyclesToRun = Math.min(
      MAX_CYCLES_PER_STEP,
      Math.floor((previousAccumulator + deltaMs + CYCLE_TIME_EPSILON_MS) / cycleTimeMs),
    );
    runtime.cycleAccumulatorMs = Math.max(
      0,
      previousAccumulator + deltaMs - cyclesToRun * cycleTimeMs,
    );
    runtime.blocked = false;
    recipes.set(node.id, recipe);
    remainingCycles.set(node.id, cyclesToRun);
    if (cyclesToRun > 0) queue.push(node.id);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const recipe = recipes.get(nodeId);
    const runtime = state.nodes[nodeId];
    const cyclesLeft = remainingCycles.get(nodeId) ?? 0;
    if (!node || !isRecipeNode(node) || !recipe || !runtime || cyclesLeft <= 0) continue;
    const cycleTimeMs = Math.max(1, recipe.cycle_time * 1000);

    let canRun = true;
    for (let inputIndex = 0; inputIndex < recipe.inputs.length; inputIndex++) {
      const input = recipe.inputs[inputIndex];
      const required = getScaledQuantity(
        input.quantity,
        node.data.machineCount,
        input.independentOfMachineCount,
      );
      const hasBootstrapLoop = edges.some((edge) => isSelfLoopInput(edge, node.id, inputIndex));
      if (
        !hasBootstrapLoop &&
        (runtime.inputBuffers[inputIndex] ?? 0) + 1e-9 < required
      ) {
        canRun = false;
        break;
      }
    }
    if (!canRun) {
      runtime.blocked = true;
      runtime.cycleAccumulatorMs = Math.min(
        MAX_CYCLES_PER_STEP * cycleTimeMs,
        runtime.cycleAccumulatorMs + cyclesLeft * cycleTimeMs,
      );
      continue;
    }

    remainingCycles.set(nodeId, cyclesLeft - 1);
    if (cyclesLeft - 1 > 0) queue.push(nodeId);
    for (let inputIndex = 0; inputIndex < recipe.inputs.length; inputIndex++) {
      const input = recipe.inputs[inputIndex];
      runtime.inputBuffers[inputIndex] = Math.max(
        0,
        (runtime.inputBuffers[inputIndex] ?? 0) -
          getScaledQuantity(input.quantity, node.data.machineCount, input.independentOfMachineCount),
      );
    }
    for (let outputIndex = 0; outputIndex < recipe.outputs.length; outputIndex++) {
      const output = recipe.outputs[outputIndex];
      const amount = getScaledQuantity(
        output.quantity,
        node.data.machineCount,
        output.independentOfMachineCount,
      );
      runtime.produced += amount;
      deliverOutput(state, edges, node.id, outputIndex, amount, remainingCycles, queue);
    }
    runtime.cycles += 1;
  }

  const producedDelta = getTotalProduced(state) - previousProduced;
  let rateWindowMs = state.rateWindowMs + deltaMs;
  let rateWindowProduced = state.rateWindowProduced + producedDelta;
  let recentRates = state.recentRates;
  let totalOutputRate = state.totalOutputRate;
  if (rateWindowMs + CYCLE_TIME_EPSILON_MS >= 1000) {
    totalOutputRate = rateWindowProduced / (rateWindowMs / 1000);
    recentRates = [...recentRates, totalOutputRate].slice(-STABILIZATION_SAMPLE_COUNT);
    rateWindowMs = 0;
    rateWindowProduced = 0;
  }
  const minRate = recentRates.length > 1 ? Math.min(...recentRates) : totalOutputRate;
  const maxRate = recentRates.length > 1 ? Math.max(...recentRates) : totalOutputRate;
  const stabilized =
    recentRates.length >= STABILIZATION_SAMPLE_COUNT &&
    maxRate > 0 &&
    (maxRate === 0 || (maxRate - minRate) / maxRate <= STABILIZATION_TOLERANCE);

  for (const runtime of Object.values(state.nodes)) {
    runtime.outputRate = state.elapsedMs > 0 ? runtime.produced / (state.elapsedMs / 1000) : 0;
  }

  return {
    ...state,
    recentRates,
    totalOutputRate,
    rateWindowMs,
    rateWindowProduced,
    status: stabilized ? 'stabilized' : 'running',
  };
}
