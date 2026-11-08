import { t } from './i18n';
import type { Graph, GraphNode, LegendGroup } from './types';

/**
 * The first four pass a colour-vision check against the page background with every pair
 * compared; the rest stay apart for full-colour vision only, so legend rows remain the way
 * to tell them apart. Orange is left out because it means "selected".
 */
const PALETTE = ['#1aa5a5', '#9085e9', '#e66767', '#008300', '#a1388d', '#1b6ab6', '#a19e1a', '#9c5132'];
const DEFAULT_GROUPS = 4;
const UNMATCHED = '#7f8a96';
const MAX_SUGGESTIONS = 5;

export const MAX_GROUPS = PALETTE.length;

export interface ColorGroup {
  rule: LegendGroup | null;
  label: string;
  title: string;
  color: string;
  members: number[];
}

export interface Candidate {
  kind: LegendGroup['kind'];
  value: string;
  count: number;
}

function matches(node: GraphNode, rule: LegendGroup): boolean {
  if (rule.kind === 'folder') return node.path.startsWith(`${rule.value}/`);
  const key = rule.value.toLowerCase();
  return node.tags.some((tag) => {
    const lower = tag.toLowerCase();
    return lower === key || lower.startsWith(`${key}/`);
  });
}

export function displayName(rule: Pick<LegendGroup, 'kind' | 'value'>): string {
  return rule.kind === 'tag' ? `#${rule.value}` : (rule.value.split('/').pop() as string);
}

/** What a vault shows until its owner edits the legend: its most used tags. */
export function defaultGroups(graph: Graph): LegendGroup[] {
  const counts = new Map<string, number>();
  for (const { tag } of graph.nodes) if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DEFAULT_GROUPS)
    .map(([value], i) => ({ kind: 'tag', value, color: PALETTE[i] }));
}

/** The colour stays with the group, so removing one never repaints the others. */
export function nextColor(groups: LegendGroup[]): string {
  return PALETTE.find((color) => !groups.some((g) => g.color === color)) ?? PALETTE[0];
}

/** A note in several groups takes the colour of the first one listed. */
export function resolveGroups(graph: Graph, groups: LegendGroup[]): { shown: ColorGroup[]; colors: string[] } {
  const colors = new Array<string | undefined>(graph.nodes.length).fill(undefined);
  const shown: ColorGroup[] = groups.map((rule) => {
    const members: number[] = [];
    graph.nodes.forEach((node, i) => {
      if (!matches(node, rule)) return;
      members.push(i);
      colors[i] ??= rule.color;
    });
    return { rule, label: displayName(rule), title: rule.value, color: rule.color, members };
  });
  const rest = colors.flatMap((color, i) => (color === undefined ? [i] : []));
  shown.push({ rule: null, label: t.other, title: t.other, color: UNMATCHED, members: rest });
  return { shown, colors: colors.map((color) => color ?? UNMATCHED) };
}

/** Every folder and tag in the vault, parents included, so a whole branch can be one group. */
export function candidatesFor(graph: Graph): Candidate[] {
  const found = new Map<string, Candidate>();
  const add = (kind: Candidate['kind'], value: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    const entry = found.get(key) ?? { kind, value, count: 0 };
    entry.count++;
    found.set(key, entry);
  };
  const branches = (parts: string[]) => parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  for (const node of graph.nodes) {
    branches(node.path.split('/').slice(0, -1)).forEach((folder) => add('folder', folder));
    new Set(node.tags.flatMap((tag) => branches(tag.split('/')))).forEach((tag) => add('tag', tag));
  }
  return [...found.values()];
}

export function suggest(candidates: Candidate[], text: string, taken: LegendGroup[]): Candidate[] {
  const query = text.trim().replace(/^#/, '').toLowerCase();
  const isTaken = (c: Candidate) => taken.some((g) => g.kind === c.kind && g.value.toLowerCase() === c.value.toLowerCase());
  return candidates
    .filter((c) => !isTaken(c) && c.value.toLowerCase().includes(query))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, MAX_SUGGESTIONS);
}
