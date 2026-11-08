/** Turns note vectors into the graph the page draws. No Node or Obsidian APIs. */
import { UMAP } from 'umap-js';
import type { Graph } from '../../src/types';

export interface NoteSource {
  path: string;
  title: string;
  mtime: number;
  /** Full tags, with or without the leading #. */
  tags: string[];
  chunks: { text: string; vector: Float32Array }[];
}

export interface GraphLabels {
  model: string;
  vault: string;
}

type Random = () => number;
type Vec = Float64Array;

const RADIUS = 100;
const KNN_EDGES = 4;
const NEIGHBOURS_KEPT = 8;
const SNIPPET_CHARS = 220;
const MIN_NOTES = 5;

function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function unit(v: Vec): Vec {
  const norm = Math.max(Math.sqrt(dot(v, v)), 1e-9);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * (q / 100);
  const low = Math.floor(at);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Principal-component scores by power iteration. */
function pca(rows: ArrayLike<number>[], components: number, random: Random): number[][] {
  const n = rows.length;
  const dim = rows[0].length;
  const mean = new Float64Array(dim);
  for (const r of rows) for (let j = 0; j < dim; j++) mean[j] += r[j] / n;
  const x = rows.map((r) => Float64Array.from({ length: dim }, (_, j) => r[j] - mean[j]));
  const axes: Vec[] = [];
  const deflate = (w: Vec) => {
    for (const a of axes) {
      const d = dot(w, a);
      for (let j = 0; j < dim; j++) w[j] -= d * a[j];
    }
  };
  for (let c = 0; c < components; c++) {
    let w: Vec = unit(Float64Array.from({ length: dim }, () => random() - 0.5));
    for (let step = 0; step < 80; step++) {
      const next: Vec = new Float64Array(dim);
      for (const row of x) {
        const d = dot(row, w);
        for (let j = 0; j < dim; j++) next[j] += d * row[j];
      }
      deflate(next);
      if (dot(next, next) < 1e-18) break;
      w = unit(next);
    }
    axes.push(w);
  }
  return x.map((row) => axes.map((a) => dot(row, a)));
}

function kmeansOnce(v: Vec[], k: number, random: Random): { labels: Int32Array; centroids: Vec[]; score: number } {
  const n = v.length;
  const centroids: Vec[] = [Float64Array.from(v[Math.floor(random() * n)])];
  const best = new Float64Array(n).fill(-Infinity);
  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      best[i] = Math.max(best[i], dot(v[i], latest));
      total += Math.max(1 - best[i], 0);
    }
    let roll = random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      roll -= Math.max(1 - best[i], 0);
      if (roll <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(Float64Array.from(v[chosen]));
  }
  const labels = new Int32Array(n).fill(-1);
  let score = 0;
  for (let iteration = 0; iteration < 60; iteration++) {
    let changed = false;
    score = 0;
    for (let i = 0; i < n; i++) {
      let top = -Infinity;
      let label = 0;
      for (let c = 0; c < k; c++) {
        const s = dot(v[i], centroids[c]);
        if (s > top) {
          top = s;
          label = c;
        }
      }
      score += top;
      if (labels[i] !== label) {
        labels[i] = label;
        changed = true;
      }
    }
    if (!changed) break;
    const sums = centroids.map(() => new Float64Array(v[0].length));
    for (let i = 0; i < n; i++) for (let j = 0; j < v[0].length; j++) sums[labels[i]][j] += v[i][j];
    sums.forEach((s, c) => {
      if (dot(s, s) > 0) centroids[c] = unit(s);
    });
  }
  return { labels, centroids, score };
}

async function cluster(v: Vec[], k: number, random: Random): Promise<{ labels: number[]; centroids: Vec[]; count: number }> {
  let best = kmeansOnce(v, k, random);
  for (let restart = 1; restart < 6; restart++) {
    await tick();
    const next = kmeansOnce(v, k, random);
    if (next.score > best.score) best = next;
  }
  // Renumber so an empty cluster can't leave a gap the page would try to label.
  const used = [...new Set(best.labels)].sort((a, b) => a - b);
  const remap = new Map(used.map((c, i) => [c, i]));
  return { labels: [...best.labels].map((c) => remap.get(c) as number), centroids: used.map((c) => best.centroids[c]), count: used.length };
}

function fitRadius(points: number[][]): number[][] {
  const medians = [0, 1, 2].map((d) => percentile(points.map((p) => p[d]), 50));
  const centred = points.map((p) => p.map((x, d) => x - medians[d]));
  const scale = RADIUS / Math.max(percentile(centred.map((p) => Math.hypot(...p)), 97), 1e-6);
  return centred.map((p) => p.map((x) => x * scale));
}

async function layoutCloud(v: Vec[], random: Random, onStep: () => void): Promise<number[][]> {
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: Math.min(12, v.length - 1),
    minDist: 0.6,
    spread: 1.6,
    random,
    distanceFn: (a, b) => 1 - dot(a, b),
  });
  const embedded = await umap.fitAsync(v.map((r) => Array.from(r)), () => onStep());
  // UMAP tends to give long, thin shapes; partly equalising the axes fills the volume.
  const rotated = pca(embedded, 3, random);
  const spreads = [0, 1, 2].map((d) => Math.max(Math.sqrt(rotated.reduce((s, p) => s + p[d] * p[d], 0) / rotated.length), 1e-6));
  return fitRadius(rotated.map((p) => p.map((x, d) => x / spreads[d] ** 0.7)));
}

/** Projects the cloud onto a sphere, then relaxes crowding so neighbourhoods stay together but stay legible. */
async function layoutGlobe(cloud: number[][], chunkCounts: number[]): Promise<number[][]> {
  const p = cloud.map((c) => {
    const d = Math.max(Math.hypot(...c), 1e-6);
    return c.map((x) => x / d);
  });
  const reach = 0.3;
  for (let iteration = 0; iteration < 60; iteration++) {
    if (iteration % 10 === 0) await tick();
    const force = p.map(() => [0, 0, 0]);
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const dx = p[i][0] - p[j][0];
        const dy = p[i][1] - p[j][1];
        const dz = p[i][2] - p[j][2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > reach * reach || d2 < 1e-9) continue;
        const push = 0.0009 / d2;
        force[i][0] += dx * push;
        force[i][1] += dy * push;
        force[i][2] += dz * push;
        force[j][0] -= dx * push;
        force[j][1] -= dy * push;
        force[j][2] -= dz * push;
      }
    }
    p.forEach((q, i) => {
      for (let d = 0; d < 3; d++) q[d] += Math.min(0.04, Math.max(-0.04, force[i][d]));
      const norm = Math.max(Math.hypot(...q), 1e-6);
      for (let d = 0; d < 3; d++) q[d] /= norm;
    });
  }
  const largest = Math.log1p(Math.max(...chunkCounts));
  return p.map((q, i) => q.map((x) => x * RADIUS * 0.95 * (1 + (0.07 * Math.log1p(chunkCounts[i])) / largest)));
}

/** Orders clusters so similar ones sit next to each other around the ring. */
function chainClusters(centroids: Vec[]): number[] {
  const order = [0];
  const left = new Set(centroids.map((_, i) => i).slice(1));
  while (left.size) {
    const last = centroids[order[order.length - 1]];
    let chosen = -1;
    let top = -Infinity;
    for (const c of left) {
      const s = dot(last, centroids[c]);
      if (s > top) {
        top = s;
        chosen = c;
      }
    }
    order.push(chosen);
    left.delete(chosen);
  }
  return order;
}

/** Clusters become segments around a hollow centre, facing the viewer. */
function layoutRing(v: Vec[], labels: number[], centroids: Vec[], random: Random): number[][] {
  const points: number[][] = v.map(() => [0, 0, 0]);
  const order = chainClusters(centroids);
  const gap = 0.07;
  const usable = 2 * Math.PI - gap * order.length;
  let angle = Math.PI / 2;
  for (const c of order) {
    const idx = labels.flatMap((l, i) => (l === c ? [i] : []));
    const span = (usable * idx.length) / v.length;
    const comps = idx.length > 2 ? pca(idx.map((i) => v[i]), 2, random) : idx.map(() => [0, 0]);
    const rank = new Array<number>(idx.length);
    [...idx.keys()].sort((a, b) => comps[a][0] - comps[b][0]).forEach((at, r) => (rank[at] = r));
    const sims = idx.map((i) => dot(v[i], centroids[c]));
    const top = Math.max(...sims);
    const range = Math.max(top - Math.min(...sims), 1e-6);
    const widest = Math.max(...comps.map((x) => Math.abs(x[1])), 1e-6);
    idx.forEach((i, at) => {
      const theta = angle + (span * rank[at]) / Math.max(idx.length - 1, 1);
      const jitter = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random()) * 1.1;
      const r = RADIUS * (0.62 + (0.42 * (top - sims[at])) / range) + jitter;
      points[i] = [r * Math.cos(theta), r * Math.sin(theta), (comps[at][1] / widest) * 13];
    });
    angle += span + gap;
  }
  return points;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'notes', 'note', 'http', 'https', 'www', 'com']);
const TOKEN = /[A-Za-z][A-Za-z0-9+#.-]+|[一-鿿]{2,}/g;

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(TOKEN) ?? []) {
    if (/^[\x00-\x7f]/.test(raw)) {
      const t = raw.replace(/\.md$/i, '').replace(/^[.-]+|[.-]+$/g, '');
      if (t.length > 2 && !STOP.has(t.toLowerCase())) out.push(t);
    } else if (raw.length <= 6) {
      // Longer runs are phrases; slicing them yields meaningless fragments.
      out.push(raw);
    }
  }
  return out;
}

/** c-TF-IDF over note titles: words frequent in one cluster and rare elsewhere. */
function labelClusters(titles: string[], labels: number[], count: number): string[] {
  const perCluster = Array.from({ length: count }, () => new Map<string, number>());
  const total = new Map<string, number>();
  const spelling = new Map<string, Map<string, number>>();
  titles.forEach((title, i) => {
    const seen = new Set<string>();
    for (const t of tokens(title)) {
      const key = t.toLowerCase();
      seen.add(key);
      const forms = spelling.get(key) ?? new Map<string, number>();
      forms.set(t, (forms.get(t) ?? 0) + 1);
      spelling.set(key, forms);
    }
    for (const key of seen) {
      perCluster[labels[i]].set(key, (perCluster[labels[i]].get(key) ?? 0) + 1);
      total.set(key, (total.get(key) ?? 0) + 1);
    }
  });
  return perCluster.map((terms, c) => {
    const size = Math.max(labels.filter((l) => l === c).length, 1);
    const score = (t: string) => {
      const n = terms.get(t) as number;
      return n > 1 ? (n / size) * Math.log(1 + titles.length / (total.get(t) as number)) : 0;
    };
    const picked: string[] = [];
    for (const t of [...terms.keys()].sort((a, b) => score(b) - score(a))) {
      if (score(t) > 0 && !picked.some((p) => p.includes(t) || t.includes(p))) picked.push(t);
      if (picked.length === 2) break;
    }
    const display = picked.map((t) => [...(spelling.get(t) as Map<string, number>)].sort((a, b) => b[1] - a[1])[0][0]);
    return display.join(' / ') || `Group ${c + 1}`;
  });
}

function snippet(text: string): string {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]*\]\]|[#>*_`~]+|\[\[|\]\]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_CHARS);
}

/**
 * Reduces each note to one top-level tag: the most common of its own, so a tag used
 * across the vault wins over a one-off. Matching ignores case, as Obsidian does.
 */
function primaryTags(notes: NoteSource[]): (string | null)[] {
  const roots = notes.map((note) => [...new Set(note.tags.map((t) => t.replace(/^#/, '').split('/')[0]).filter(Boolean))]);
  const count = new Map<string, number>();
  const spelling = new Map<string, string>();
  for (const tag of roots.flat()) {
    const key = tag.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
    if (!spelling.has(key)) spelling.set(key, tag);
  }
  return roots.map((tags) => {
    const keys = tags.map((t) => t.toLowerCase()).sort((a, b) => (count.get(b) as number) - (count.get(a) as number) || a.localeCompare(b));
    return keys.length ? (spelling.get(keys[0]) as string) : null;
  });
}

const round = (x: number, digits = 100) => Math.round(x * digits) / digits;
const flatten = (points: number[][]) => points.flatMap((p) => p.map((x) => round(x)));

export async function buildGraph(
  source: NoteSource[],
  linkPaths: [string, string][],
  labels: GraphLabels,
  onProgress: (message: string) => void = () => {},
): Promise<Graph> {
  const notes = [...source].sort((a, b) => (a.path < b.path ? -1 : 1));
  const n = notes.length;
  if (n < MIN_NOTES) throw new Error(`Need at least ${MIN_NOTES} indexed notes, found ${n}.`);
  const random = seeded(42);
  const dim = notes[0].chunks[0].vector.length;
  const v: Vec[] = notes.map((note) => {
    const mean = new Float64Array(dim);
    for (const { vector } of note.chunks) for (let j = 0; j < dim; j++) mean[j] += vector[j];
    return unit(mean);
  });
  const chunkCounts = notes.map((note) => note.chunks.length);

  onProgress('clustering');
  const k = Math.min(Math.max(Math.round(Math.sqrt(n / 4)), 6), 14, n - 1);
  const { labels: assignment, centroids, count } = await cluster(v, k, random);
  const names = labelClusters(notes.map((note) => note.title), assignment, count);

  onProgress('layout');
  const cloud = await layoutCloud(v, random, () => {});
  const globe = await layoutGlobe(cloud, chunkCounts);
  const ring = layoutRing(v, assignment, centroids, random);

  onProgress('connections');
  await tick();
  const ranked = v.map((a, i) => {
    const scored: [number, number][] = [];
    v.forEach((b, j) => {
      if (j !== i) scored.push([j, dot(a, b)]);
    });
    return scored.sort((x, y) => y[1] - x[1]).slice(0, NEIGHBOURS_KEPT);
  });
  const cutoff = percentile(ranked.flatMap((r) => r.slice(0, KNN_EDGES).map(([, s]) => s)), 25);
  const semantic = new Map<string, [number, number]>();
  ranked.forEach((list, i) => {
    list.slice(0, KNN_EDGES).forEach(([j, s], position) => {
      if (position === 0 || s >= cutoff) semantic.set(`${Math.min(i, j)}:${Math.max(i, j)}`, [Math.min(i, j), Math.max(i, j)]);
    });
  });

  const tags = primaryTags(notes);
  const indexOf = new Map(notes.map((note, i) => [note.path, i]));
  const links = new Map<string, [number, number]>();
  for (const [from, to] of linkPaths) {
    const a = indexOf.get(from);
    const b = indexOf.get(to);
    if (a !== undefined && b !== undefined && a !== b) links.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [Math.min(a, b), Math.max(a, b)]);
  }

  return {
    meta: {
      generatedAt: Date.now(),
      model: labels.model,
      vault: labels.vault,
      notes: n,
      chunks: chunkCounts.reduce((a, b) => a + b, 0),
    },
    clusters: names.map((label, c) => ({ label, size: assignment.filter((l) => l === c).length })),
    nodes: notes.map((note, i) => ({
      title: note.title.replace(/\.md$/, ''),
      path: note.path,
      cluster: assignment[i],
      tag: tags[i],
      tags: [...new Set(notes[i].tags.map((tag) => tag.replace(/^#/, '')).filter(Boolean))],
      mtime: note.mtime,
      chunks: chunkCounts[i],
      snippet: snippet(note.chunks[0].text),
      neighbours: ranked[i].map(([j, s]) => [j, round(s, 1000)]),
    })),
    layouts: { cloud: flatten(cloud), globe: flatten(globe), ring: flatten(ring) },
    edges: { semantic: [...semantic.values()], links: [...links.values()] },
  };
}
