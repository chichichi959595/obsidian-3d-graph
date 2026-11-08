import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, getAllTags, type App } from 'obsidian';
import { AnalogyError, databasePath, readNotes, sourceStamp } from './analogy.ts';
import { HandAssets } from './hand-assets.ts';
import { buildGraph } from './pipeline.ts';
import { parseLegend } from './legend.ts';
import { LocalServer } from './server.ts';
import type { LegendGroup } from '../../src/types.ts';
import { s } from './strings.ts';

interface Settings {
  port: number;
  token: string;
  /** Null until the owner edits the legend. */
  legend: LegendGroup[] | null;
}

const DEFAULT_PORT = 27183;
/** Bump when the graph's shape changes, so older caches get rebuilt. */
const GRAPH_FORMAT = 3;

function dataRoot(): string {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : join(homedir(), 'Library', 'Application Support');
  const root = join(base, 'Notes Graph 3D');
  mkdirSync(root, { recursive: true });
  return root;
}

export default class NotesGraph3D extends Plugin {
  settings: Settings = { port: DEFAULT_PORT, token: '', legend: null };
  private server: LocalServer | null = null;
  private hands!: HandAssets;
  private root = '';
  private graphJson: string | null = null;
  private graphStamp = -1;
  private building: Promise<boolean> | null = null;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { port: saved?.port ?? DEFAULT_PORT, token: saved?.token || randomBytes(24).toString('hex'), legend: parseLegend(saved?.legend) };
    await this.saveData(this.settings);
    this.root = dataRoot();
    this.hands = new HandAssets(this.root);

    this.addRibbonIcon('orbit', s.ribbon, () => void this.open());
    this.addCommand({ id: 'open', name: s.commandOpen, callback: () => void this.open() });
    this.addCommand({ id: 'rebuild', name: s.commandRebuild, callback: () => void this.open(true) });
    this.addSettingTab(new NotesGraph3DSettings(this.app, this));
  }

  onunload(): void {
    this.server?.stop();
    this.server = null;
  }

  private log(context: string, error: unknown): void {
    console.error(`[Notes Graph 3D] ${context}`, error);
    try {
      appendFileSync(join(this.root, 'error.log'), `${new Date().toISOString()} ${context}: ${error instanceof Error ? error.stack : String(error)}\n`);
    } catch {
      // Logging must never turn into a second failure.
    }
  }

  private get vaultPath(): string {
    const { adapter } = this.app.vault;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error('Vault is not on the local file system.');
  }

  private get cachePath(): string {
    return join(this.root, `graph-${this.settings.token.slice(0, 12)}.json`);
  }

  async open(force = false): Promise<void> {
    if (!(await this.ensureGraph(force))) return;
    if (!(await this.ensureServer()) || !this.server) return;
    const { shell } = (window.require as NodeRequire)('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(this.server.url);
  }

  async restartServer(): Promise<void> {
    if (!this.server) return;
    this.server.stop();
    this.server = null;
    await this.ensureServer();
  }

  private async ensureServer(): Promise<boolean> {
    if (this.server?.running) return true;
    const server = new LocalServer(this.settings.port, this.settings.token, () => this.graphJson, this.hands, {
      read: () => this.settings.legend,
      write: async (legend) => {
        this.settings.legend = legend;
        await this.saveData(this.settings);
      },
    });
    try {
      await server.start();
      this.server = server;
      return true;
    } catch (error) {
      this.log('server start', error);
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      new Notice(busy ? s.portBusy(this.settings.port) : s.serverFailed);
      return false;
    }
  }

  private ensureGraph(force: boolean): Promise<boolean> {
    this.building ??= this.buildIfStale(force).finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async buildIfStale(force: boolean): Promise<boolean> {
    try {
      const dbPath = databasePath(this.vaultPath);
      const stamp = sourceStamp(dbPath);
      if (!force && this.graphJson && stamp === this.graphStamp) return true;
      if (!force && this.loadCache(stamp)) return true;

      const notice = new Notice(s.building, 0);
      try {
        const { model, notes } = readNotes(dbPath);
        for (const note of notes) {
          const cache = this.app.metadataCache.getCache(note.path);
          note.tags = (cache && getAllTags(cache)) ?? [];
        }
        const links = Object.entries(this.app.metadataCache.resolvedLinks).flatMap(([from, targets]) =>
          Object.keys(targets).map((to): [string, string] => [from, to]),
        );
        const graph = await buildGraph(notes, links, { model, vault: this.app.vault.getName() });
        this.graphJson = JSON.stringify(graph);
        this.graphStamp = stamp;
        writeFileSync(this.cachePath, JSON.stringify({ format: GRAPH_FORMAT, stamp, graph: this.graphJson }));
      } finally {
        notice.hide();
      }
      return true;
    } catch (error) {
      this.log('build graph', error);
      if (error instanceof AnalogyError) new Notice(s.analogy[error.reason], 10000);
      else new Notice(s.buildFailed, 10000);
      return false;
    }
  }

  private loadCache(stamp: number): boolean {
    if (!existsSync(this.cachePath)) return false;
    try {
      const cached = JSON.parse(readFileSync(this.cachePath, 'utf8')) as { format?: number; stamp: number; graph: string };
      if (cached.format !== GRAPH_FORMAT || cached.stamp !== stamp) return false;
      this.graphJson = cached.graph;
      this.graphStamp = stamp;
      return true;
    } catch {
      return false;
    }
  }
}

class NotesGraph3DSettings extends PluginSettingTab {
  private readonly plugin: NotesGraph3D;

  constructor(app: App, plugin: NotesGraph3D) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName(s.portName)
      .setDesc(s.portDesc)
      .addText((text) =>
        text.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
          const port = Number(value);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
          this.plugin.settings.port = port;
          await this.plugin.saveData(this.plugin.settings);
          await this.plugin.restartServer();
        }),
      );
  }
}
