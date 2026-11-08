export type LayoutName = 'cloud' | 'globe' | 'ring';
export type EdgeKind = 'semantic' | 'links';

export interface GraphNode {
  title: string;
  path: string;
  cluster: number;
  /** Top-level tag that best identifies the note, or null when it has none. */
  tag: string | null;
  /** Every tag on the note, without the leading #. */
  tags: string[];
  mtime: number;
  chunks: number;
  snippet: string;
  neighbours: [number, number][];
}

export interface Graph {
  meta: { generatedAt: number; model: string; vault: string; notes: number; chunks: number };
  clusters: { label: string; size: number }[];
  nodes: GraphNode[];
  layouts: Record<LayoutName, number[]>;
  edges: Record<EdgeKind, [number, number][]>;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** False when the point is behind the camera or outside the clip volume. */
  visible: boolean;
  /** Negative when the point is farther away than the orbit target. */
  nearness: number;
}

/** One row of the legend, chosen by the vault's owner. */
export interface LegendGroup {
  kind: 'folder' | 'tag';
  value: string;
  color: string;
}
