import { computeForceLayout, type LayoutEdge, type LayoutNode, type LayoutOptions } from './forceLayout';

export interface LayoutRequest extends LayoutOptions {
  requestId: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { requestId, nodes, edges, width, height } = event.data;
  const positions = computeForceLayout(nodes, edges, { width, height });
  (self as unknown as Worker).postMessage({ requestId, positions });
};
