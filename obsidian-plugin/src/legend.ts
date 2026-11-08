import type { LegendGroup } from '../../src/types.ts';

const MAX_GROUPS = 8;
const MAX_VALUE_LENGTH = 300;

/** Null unless `value` is a well-formed legend. The page and data.json are both outside this code's control. */
export function parseLegend(value: unknown): LegendGroup[] | null {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) return null;
  const groups: LegendGroup[] = [];
  for (const item of value as Partial<LegendGroup>[]) {
    if (item === null || typeof item !== 'object') return null;
    const { kind, value: name, color } = item;
    if (kind !== 'folder' && kind !== 'tag') return null;
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_VALUE_LENGTH) return null;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null;
    groups.push({ kind, value: name, color });
  }
  return groups;
}
