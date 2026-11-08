// Writes public/data/graph.json for `pnpm dev`, using the same pipeline as the plugin.
// In the plugin, links come from Obsidian's own link resolver instead of the regexes here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { databasePath, readNotes } from '../obsidian-plugin/src/analogy.ts';
import { buildGraph, type NoteSource } from '../obsidian-plugin/src/pipeline.ts';

const vault = process.env.VAULT_PATH ?? join(homedir(), 'Documents/obsidian_notes/Notes');
const out = join(import.meta.dirname, '../public/data/graph.json');

function extractLinks(notes: NoteSource[]): [string, string][] {
  const paths = new Set(notes.map((n) => n.path));
  const byStem = new Map(notes.map((n) => [basename(n.path, '.md').toLowerCase(), n.path]));
  return notes.flatMap((note) => {
    let body: string;
    try {
      body = readFileSync(join(vault, note.path), 'utf8');
    } catch {
      return [];
    }
    const targets = [
      ...[...body.matchAll(/\[\[([^\]|#^]+)/g)].map((m) => m[1].trim()),
      ...[...body.matchAll(/\]\(([^)#\s]+?\.md)(?:#[^)]*)?\)/g)].filter((m) => !m[1].includes('://')).map((m) => decodeURIComponent(m[1])),
    ];
    return targets.flatMap((target): [string, string][] => {
      const relative = normalize(join(dirname(note.path), target));
      const hit = paths.has(relative) ? relative : paths.has(target) ? target : byStem.get(basename(target, '.md').toLowerCase());
      return hit ? [[note.path, hit]] : [];
    });
  });
}

function extractTags(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(vault, path), 'utf8');
  } catch {
    return [];
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const tags: string[] = [];
  if (front) {
    const inline = /^tags?:\s*\[(.*?)\]/m.exec(front[1]);
    if (inline) tags.push(...inline[1].split(',').map((t) => t.trim().replace(/^["'#]+|["']+$/g, '')));
    const list = /^tags?:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(front[1]);
    if (list) tags.push(...[...list[1].matchAll(/-\s*(.+)/g)].map((m) => m[1].trim().replace(/^["'#]+|["']+$/g, '')));
  }
  const body = (front ? text.slice(front[0].length) : text).replace(/```[\s\S]*?```/g, '');
  tags.push(...[...body.matchAll(/(?<![\w/#])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)].map((m) => m[1]));
  return tags;
}

const { model, notes } = readNotes(databasePath(vault));
for (const note of notes) note.tags = extractTags(note.path);
const started = Date.now();
const graph = await buildGraph(notes, extractLinks(notes), { model, vault: basename(vault) }, (m) => console.log(m));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(graph));
console.log(`${graph.meta.notes} notes, ${graph.edges.semantic.length} semantic edges, ${graph.edges.links.length} links in ${Date.now() - started} ms (${model})`);
console.log(graph.clusters.map((c) => `[${c.size}] ${c.label}`).join('\n'));
