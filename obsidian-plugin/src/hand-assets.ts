/** Downloads the hand-tracking runtime and model on request, outside the vault so sync tools skip them. */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import { HAND_FILES, type HandFile } from 'virtual:hand-manifest';

export type HandAssetStatus =
  | { state: 'missing'; totalBytes: number }
  | { state: 'downloading'; received: number; totalBytes: number }
  | { state: 'failed'; message: string; totalBytes: number }
  | { state: 'ready' };

const TOTAL_BYTES = HAND_FILES.reduce((sum, f) => sum + f.size, 0);
const MAX_REDIRECTS = 4;

function fetchTo(url: string, target: string, onBytes: (n: number) => void, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
        res.resume();
        fetchTo(new URL(res.headers.location, url).href, target, onBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const hash = createHash('sha256');
      const out = createWriteStream(target);
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        onBytes(chunk.length);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve(hash.digest('hex')));
      res.pipe(out);
    }).on('error', reject);
  });
}

export class HandAssets {
  private readonly dir: string;
  private status: HandAssetStatus;

  constructor(rootDir: string) {
    this.dir = join(rootDir, 'hand-assets');
    this.status = this.complete() ? { state: 'ready' } : { state: 'missing', totalBytes: TOTAL_BYTES };
  }

  getStatus(): HandAssetStatus {
    return this.status;
  }

  private present(file: HandFile): boolean {
    const path = join(this.dir, file.path);
    return existsSync(path) && statSync(path).size === file.size;
  }

  private complete(): boolean {
    return HAND_FILES.every((f) => this.present(f));
  }

  /** Absolute path for a request path; null for anything outside the fixed file list. */
  resolve(requestPath: string): string | null {
    const file = HAND_FILES.find((f) => f.path === requestPath);
    return file && this.present(file) ? join(this.dir, file.path) : null;
  }

  download(): void {
    if (this.status.state === 'downloading' || this.status.state === 'ready') return;
    void this.run();
  }

  private async run(): Promise<void> {
    let received = 0;
    this.status = { state: 'downloading', received, totalBytes: TOTAL_BYTES };
    const bump = (n: number) => {
      received += n;
      this.status = { state: 'downloading', received, totalBytes: TOTAL_BYTES };
    };
    try {
      for (const file of HAND_FILES) {
        const target = join(this.dir, file.path);
        if (this.present(file)) {
          bump(file.size);
          continue;
        }
        mkdirSync(join(target, '..'), { recursive: true });
        const part = `${target}.part`;
        const digest = await fetchTo(file.url, part, bump);
        if (digest !== file.sha256) {
          rmSync(part, { force: true });
          throw new Error(`Checksum mismatch for ${file.path}`);
        }
        renameSync(part, target);
      }
      this.status = { state: 'ready' };
    } catch (error) {
      this.status = { state: 'failed', message: (error as Error).message, totalBytes: TOTAL_BYTES };
    }
  }
}
