/**
 * The only file that knows how Analogy stores vectors. Its database is a private
 * format, so everything is validated and an unknown layout fails with a clear reason.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { NoteSource } from './pipeline.ts';

const SUPPORTED_SCHEMAS = ['1'];

export type AnalogyFailure = 'unsupported-platform' | 'unsupported-runtime' | 'not-indexed' | 'unsupported-version' | 'empty';

export class AnalogyError extends Error {
  readonly reason: AnalogyFailure;

  constructor(reason: AnalogyFailure, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

function localDataRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Analogy');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Analogy');
  throw new AnalogyError('unsupported-platform', `Analogy does not support ${process.platform}.`);
}

function vaultId(vaultPath: string): string {
  const isWindows = process.platform === 'win32';
  const resolved = (isWindows ? win32 : posix).resolve(vaultPath).normalize('NFC');
  const canonical = isWindows ? resolved.toLowerCase() : resolved;
  return `vault-v2-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)}`;
}

export function databasePath(vaultPath: string): string {
  const path = join(localDataRoot(), 'vaults', vaultId(vaultPath), 'vector-store', 'vectors.sqlite');
  if (!existsSync(path)) throw new AnalogyError('not-indexed', `No Analogy index at ${path}.`);
  return path;
}

/** Changes whenever Analogy writes, including writes still sitting in the WAL. */
export function sourceStamp(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`].reduce((latest, p) => (existsSync(p) ? Math.max(latest, statSync(p).mtimeMs) : latest), 0);
}

function open(dbPath: string): DatabaseSync {
  // Resolved at run time: bundlers and older Electron builds must not see this as a static import.
  let Database: typeof DatabaseSync;
  try {
    ({ DatabaseSync: Database } = createRequire(import.meta.url ?? __filename)('node:sqlite') as typeof import('node:sqlite'));
  } catch (error) {
    throw new AnalogyError('unsupported-runtime', `node:sqlite is unavailable: ${String(error)}`);
  }
  return new Database(dbPath, { readOnly: true });
}

function toVector(bytes: Uint8Array, dimension: number): Float32Array {
  if (bytes.length !== dimension * 4) {
    throw new AnalogyError('unsupported-version', `Vector is ${bytes.length} bytes, expected ${dimension * 4}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: dimension }, (_, i) => view.getFloat32(i * 4, true));
}

export function readNotes(dbPath: string): { model: string; notes: NoteSource[] } {
  const db = open(dbPath);
  try {
    let collection: { id: string; name: string; dimension: number } | undefined;
    let rows: { document: string | null; metadata: string; embedding: Uint8Array }[];
    try {
      const schema = db.prepare(`select value from meta where key = 'schema_version'`).get() as { value: string } | undefined;
      if (!schema || !SUPPORTED_SCHEMAS.includes(schema.value)) {
        throw new AnalogyError('unsupported-version', `Unknown Analogy schema: ${schema?.value ?? 'none'}.`);
      }
      // A model change can leave an old collection behind; vectors from two models must never mix.
      collection = db
        .prepare(
          `select c.id, c.name, c.dimension from collections c
           where exists (select 1 from records r where r.collection_id = c.id)
           order by c.created_at desc limit 1`,
        )
        .get() as typeof collection;
      if (!collection) throw new AnalogyError('empty', 'The Analogy index has no notes yet.');
      rows = db
        .prepare('select document, metadata, embedding from records where collection_id = ?')
        .all(collection.id) as unknown as typeof rows;
    } catch (error) {
      if (error instanceof AnalogyError) throw error;
      throw new AnalogyError('unsupported-version', (error as Error).message);
    }

    const byPath = new Map<string, NoteSource & { order: number[] }>();
    for (const row of rows) {
      const meta = JSON.parse(row.metadata) as { path?: string; title?: string; mtime?: number; chunk_index?: number };
      if (typeof meta.path !== 'string' || typeof meta.chunk_index !== 'number') {
        throw new AnalogyError('unsupported-version', 'Record metadata has an unknown shape.');
      }
      const note = byPath.get(meta.path) ?? { path: meta.path, title: meta.title ?? meta.path, mtime: meta.mtime ?? 0, tags: [], chunks: [], order: [] };
      note.chunks.push({ text: row.document ?? '', vector: toVector(row.embedding, collection.dimension) });
      note.order.push(meta.chunk_index);
      byPath.set(meta.path, note);
    }
    const notes = [...byPath.values()].map(({ order, chunks, ...note }) => ({
      ...note,
      chunks: [...chunks.keys()].sort((a, b) => order[a] - order[b]).map((i) => chunks[i]),
    }));
    const model = /_([^_]+)_[0-9a-f]+$/.exec(collection.name)?.[1] ?? collection.name;
    return { model, notes };
  } finally {
    db.close();
  }
}
