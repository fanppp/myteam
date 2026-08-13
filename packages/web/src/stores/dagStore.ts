import { create } from 'zustand';
import type { Edge, Node } from '@xyflow/react';

interface RoleNodeData {
  roleId: string;
  status: string;
  content: string;
  toolName?: string;
  teamStrengths?: string;
  caution?: string | null;
}

interface DAGState {
  nodes: Node[];
  edges: Edge[];
  taskId: string | null;
  taskStatus: string | null;
  processedEventIds: Set<number>;
  setTask: (taskId: string) => void;
  setTaskStatus: (status: string) => void;
  initTeam: (taskId: string, roles: { id: string; team_strengths?: string; caution?: string | null }[], strategy: string) => void;
  handleEvent: (event: any) => void;
  reset: () => void;
}

let nodeCounter = 0;
const NODE_WIDTH = 340;
const NODE_HEIGHT = 140;
const H_GAP = 50;
const V_GAP = 40;

function getPosition(index: number, parallel = false): { x: number; y: number } {
  if (parallel) {
    return { x: index * (NODE_WIDTH + H_GAP), y: 0 };
  }
  return { x: index * (NODE_WIDTH + H_GAP), y: 0 };
}

export const useDAGStore = create<DAGState>((set, get) => ({
  nodes: [],
  edges: [],
  taskId: null,
  taskStatus: null,
  processedEventIds: new Set<number>(),

  setTask: (taskId) => set({ taskId, nodes: [], edges: [], processedEventIds: new Set() }),

  setTaskStatus: (status) => set({ taskStatus: status }),

  reset: () => set({ nodes: [], edges: [], taskId: null, taskStatus: null, processedEventIds: new Set() }),

  initTeam: (taskId, roles, strategy) => {
    const nodes: Node[] = roles.map((role, i) => {
      let position: { x: number; y: number };
      if (strategy === 'parallel') {
        const isLast = i === roles.length - 1;
        if (isLast) {
          position = { x: (NODE_WIDTH + H_GAP), y: ((roles.length - 1) * (NODE_HEIGHT + V_GAP)) / 2 };
        } else {
          position = { x: 0, y: i * (NODE_HEIGHT + V_GAP) };
        }
      } else {
        position = { x: i * (NODE_WIDTH + H_GAP), y: 0 };
      }
      return {
        id: `${taskId}-${role.id}`,
        type: 'roleNode',
        position,
        data: {
          roleId: role.id,
          status: 'pending',
          content: '',
          teamStrengths: role.team_strengths,
          caution: role.caution,
        } as RoleNodeData,
      };
    });
    set({ nodes, edges: [], processedEventIds: new Set(), taskId });
  },

  handleEvent: (event) => {
    const state = get();
    if (state.processedEventIds.has(event.eventId)) return;

    const newProcessed = new Set(state.processedEventIds);
    newProcessed.add(event.eventId);

    const { type, nodeId, roleId, content, status, fromNode, toNode, toolName } = event;

    switch (type) {
      case 'node_start': {
        if (state.nodes.some(n => n.id === nodeId)) {
          const nodes = state.nodes.map(n =>
            n.id === nodeId
              ? { ...n, data: { ...(n.data as RoleNodeData), status: 'running' as const } }
              : n
          );
          set({ nodes, processedEventIds: newProcessed });
          return;
        }
        const index = state.nodes.length;
        const newNode: Node = {
          id: nodeId,
          type: 'roleNode',
          position: getPosition(index),
          data: { roleId, status: 'running', content: '' } as RoleNodeData,
        };
        set({ nodes: [...state.nodes, newNode], processedEventIds: newProcessed });
        break;
      }
      case 'node_output': {
        const nodes = state.nodes.map(n => {
          if (n.id === nodeId) {
            const data = n.data as RoleNodeData;
            return {
              ...n,
              data: {
                ...data,
                content: data.content + (content || ''),
                status: status || data.status,
              },
            };
          }
          return n;
        });
        set({ nodes, processedEventIds: newProcessed });
        break;
      }
      case 'node_complete': {
        const nodes = state.nodes.map(n => {
          if (n.id === nodeId) {
            return { ...n, data: { ...(n.data as RoleNodeData), status: 'done' } };
          }
          return n;
        });
        set({ nodes, processedEventIds: newProcessed });
        break;
      }
      case 'node_error': {
        const nodes = state.nodes.map(n => {
          if (n.id === nodeId) {
            return { ...n, data: { ...(n.data as RoleNodeData), status: 'error', content: content || 'Error' } };
          }
          return n;
        });
        set({ nodes, processedEventIds: newProcessed });
        break;
      }
      case 'edge': {
        const edgeId = `${fromNode}->${toNode}`;
        if (state.edges.some(e => e.id === edgeId)) {
          set({ processedEventIds: newProcessed });
          return;
        }
        const newEdge: Edge = {
          id: edgeId,
          source: fromNode,
          target: toNode,
          animated: true,
          style: { stroke: '#6366f1', strokeWidth: 2 },
        };
        set({ edges: [...state.edges, newEdge], processedEventIds: newProcessed });
        break;
      }
      case 'tool_use': {
        const nodes = state.nodes.map(n => {
          if (n.id === nodeId) {
            return { ...n, data: { ...(n.data as RoleNodeData), status: 'tool', toolName } };
          }
          return n;
        });
        set({ nodes, processedEventIds: newProcessed });
        break;
      }
      case 'tool_result': {
        const nodes = state.nodes.map(n => {
          if (n.id === nodeId) {
            return { ...n, data: { ...(n.data as RoleNodeData), status: 'running', toolName: undefined } };
          }
          return n;
        });
        set({ nodes, processedEventIds: newProcessed });
        break;
      }
      case 'task_done': {
        set({ taskStatus: status || 'done', processedEventIds: newProcessed });
        break;
      }
      default:
        set({ processedEventIds: newProcessed });
    }
  },
}));
