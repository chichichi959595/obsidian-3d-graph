import '@fontsource-variable/saira/wght.css';
import './style.css';
import { candidatesFor, defaultGroups, MAX_GROUPS, nextColor, resolveGroups, suggest, type Candidate, type ColorGroup } from './colors';
import { dateLocale, switchLanguage, t, translatePage } from './i18n';
import { Hologram } from './hologram';
import type { GestureMode, GestureResult } from './gestures';
import type { HandTracker, HandTrackerError } from './hands';
import type { EdgeKind, Graph, LayoutName, LegendGroup, ScreenPoint } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
interface LabelItem {
  text: string;
  kind: 'cluster' | 'note' | 'hover';
  point: () => ScreenPoint;
}

const GESTURE_STATUS: Record<GestureMode, string> = {
  none: t.gestureNone,
  open: t.gestureOpen,
  aim: t.gestureAim,
  grab: t.gestureGrab,
  zoom: t.gestureZoom,
};

const GESTURE_ERRORS: Record<HandTrackerError, string> = {
  'camera-denied': t.cameraDenied,
  'camera-missing': t.cameraMissing,
  'model-failed': t.modelFailed,
};

const DWELL_NODE_MS = 3000;
const DWELL_CONTROL_MS = 1000;
/** How long after the last sighting of a hand before the idle spin may resume. */
const HAND_GONE_MS = 1500;
const DWELL_EMPTY_MS = 1600;
const MAGNET_PX = 56;
const REARM_PX = 70;

type HandAssetStatus =
  | { state: 'missing'; totalBytes: number }
  | { state: 'downloading'; received: number; totalBytes: number }
  | { state: 'failed'; message: string; totalBytes: number }
  | { state: 'ready' };

interface AimTarget {
  key: number | HTMLElement | 'empty';
  dwell: number;
  node: number | null;
  control: HTMLElement | null;
}

function showError(message: string): void {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
}

/** `persists` is false when the page isn't served by the plugin, as under `pnpm dev`. */
async function loadLegend(): Promise<{ saved: LegendGroup[] | null; persists: boolean }> {
  try {
    const res = await fetch('api/legend');
    if (res.ok) return { saved: (await res.json()) as LegendGroup[] | null, persists: true };
  } catch {
    // Falls through to the unsaved default below.
  }
  return { saved: null, persists: false };
}

async function loadGraph(): Promise<Graph | null> {
  try {
    const res = await fetch('data/graph.json');
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Graph;
  } catch {
    showError(t.noGraph);
    return null;
  }
}

function webglAvailable(): boolean {
  return !!document.createElement('canvas').getContext('webgl2');
}

class Interface {
  private selected: number | null = null;
  private hover: number | null = null;
  private booted = false;
  private activeGroup: ColorGroup | null = null;
  private rules: LegendGroup[];
  private legendSave: Promise<void> = Promise.resolve();
  private readonly legendCandidates: Candidate[];
  private handSeenAt = 0;
  private tracker: HandTracker | null = null;
  private gestureOn = false;
  private gestureBusy = false;
  private gestureMode: GestureMode | null = null;
  private handHover: Element | null = null;
  private aimTarget: AimTarget | null = null;
  private aimSince = 0;
  private aimFiredAt: { x: number; y: number } | null = null;
  private query = '';
  private matches: number[] = [];
  private activeResult = -1;
  private labels: LabelItem[] = [];
  private readonly labelEls: HTMLDivElement[] = [];
  private readonly labelBox = $('labels');
  private readonly panel = $('panel');
  private readonly results = $<HTMLUListElement>('results');
  private readonly search = $<HTMLInputElement>('search');
  private readonly linkMap: number[][];
  private readonly clusterLabels: LabelItem[];

  constructor(
    private readonly holo: Hologram,
    private readonly graph: Graph,
    savedLegend: LegendGroup[] | null,
    private readonly legendPersists: boolean,
  ) {
    this.rules = savedLegend ?? defaultGroups(graph);
    this.legendCandidates = candidatesFor(graph);
    this.linkMap = graph.nodes.map(() => []);
    for (const [a, b] of graph.edges.links) {
      this.linkMap[a].push(b);
      this.linkMap[b].push(a);
    }
    this.clusterLabels = graph.clusters.map((c, i) => ({
      text: c.label,
      kind: 'cluster',
      point: () => holo.clusterCentre(i),
    }));
    this.labels = this.clusterLabels;

    $('vault-name').textContent = graph.meta.vault;
    $('vault-stats').textContent = t.stats(graph.meta.notes.toLocaleString('en-US'), graph.meta.chunks.toLocaleString('en-US'));

    holo.onFrame = () => this.updateLabels();
    this.applyLegend();
    this.bindLegend();
    this.bindCanvas($<HTMLCanvasElement>('holo'));
    this.bindControls();
    this.bindKeyboard();
  }

  private bindCanvas(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      this.setHover(this.holo.pick(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.selectAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 28 : 16);
    });
  }

  private applyLegend(): void {
    const { shown, colors } = resolveGroups(this.graph, this.rules);
    this.holo.setNodeColors(colors);
    this.activeGroup = null;
    this.renderLegend(shown);
    const add = $<HTMLButtonElement>('legend-add');
    add.disabled = this.rules.length >= MAX_GROUPS;
    add.textContent = add.disabled ? t.legendFull : t.addGroup;
    if (this.selected === null && !this.query) this.holo.clearFocus();
  }

  private changeLegend(rules: LegendGroup[]): void {
    this.rules = rules;
    this.applyLegend();
    if (!this.legendPersists) return;
    const body = JSON.stringify(rules);
    this.legendSave = this.legendSave.then(async () => {
      const saved = await fetch('api/legend', { method: 'POST', body }).then((r) => r.ok, () => false);
      $('legend-error').hidden = saved;
    });
  }

  private renderLegend(groups: ColorGroup[]): void {
    $('legend-list').replaceChildren(
      ...groups.map((group) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'row';
        button.title = group.title;
        button.setAttribute('aria-pressed', 'false');
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = group.color;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = group.label;
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(group.members.length);
        button.append(swatch, name, count);
        button.addEventListener('click', () => this.toggleGroup(group, button));
        const li = document.createElement('li');
        li.append(button);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.textContent = '×';
        li.append(remove);
        const { rule } = group;
        if (rule) {
          remove.setAttribute('aria-label', t.removeGroup(group.label));
          remove.addEventListener('click', () => this.changeLegend(this.rules.filter((r) => r !== rule)));
        } else {
          remove.hidden = true;
          // Keeps the count lined up with the removable rows above it.
          li.style.paddingRight = '26px';
        }
        return li;
      }),
    );
  }

  private openLegendForm(): void {
    $('legend-add').hidden = true;
    $('legend-form').hidden = false;
    const input = $<HTMLInputElement>('legend-input');
    input.value = '';
    input.focus();
    this.renderSuggestions();
  }

  private closeLegendForm(): void {
    $('legend-form').hidden = true;
    $('legend-add').hidden = false;
  }

  private currentSuggestions(): Candidate[] {
    return suggest(this.legendCandidates, $<HTMLInputElement>('legend-input').value, this.rules);
  }

  private addToLegend(choice: Candidate): void {
    this.closeLegendForm();
    this.changeLegend([...this.rules, { kind: choice.kind, value: choice.value, color: nextColor(this.rules) }]);
  }

  private renderSuggestions(): void {
    const items = this.currentSuggestions().map((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = choice.value;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = choice.kind === 'tag' ? `#${choice.value}` : choice.value;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(choice.count);
      button.append(name, count);
      button.addEventListener('click', () => this.addToLegend(choice));
      const li = document.createElement('li');
      li.append(button);
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t.noSuggestions;
      items.push(li);
    }
    $('legend-suggestions').replaceChildren(...items);
  }

  private bindLegend(): void {
    const form = $('legend-form');
    const input = $<HTMLInputElement>('legend-input');
    $('legend-add').addEventListener('click', () => this.openLegendForm());
    input.addEventListener('input', () => this.renderSuggestions());
    input.addEventListener('keydown', (e) => {
      // Letters typed here must not reach the page's keyboard shortcuts.
      e.stopPropagation();
      if (e.key === 'Escape') this.closeLegendForm();
      if (e.key === 'Enter') {
        const [first] = this.currentSuggestions();
        if (first) this.addToLegend(first);
      }
    });
    // Without this, pressing a suggestion blurs the input and closes the form before the click lands.
    $('legend-suggestions').addEventListener('mousedown', (e) => e.preventDefault());
    form.addEventListener('focusout', (e) => {
      if (!form.contains(e.relatedTarget as Node | null)) this.closeLegendForm();
    });
  }

  private toggleGroup(group: ColorGroup, button: HTMLButtonElement): void {
    const turningOn = this.activeGroup !== group;
    this.activeGroup = turningOn ? group : null;
    document.querySelectorAll('#legend-list .row').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    button.setAttribute('aria-pressed', String(turningOn));
    if (this.selected !== null || this.query) return;
    if (turningOn) this.holo.showMatches(group.members);
    else this.holo.clearFocus();
  }

  /** Back to the resting view, keeping any legend highlight. */
  private restoreIdleView(): void {
    this.holo.clearFocus();
    if (this.activeGroup) this.holo.showMatches(this.activeGroup.members);
    this.labels = this.clusterLabels;
  }

  private selectAt(x: number, y: number, radius: number): void {
    const hit = this.holo.pick(x, y, radius);
    if (hit !== null) this.select(hit);
    else if (this.selected !== null) this.deselect();
  }

  private async toggleGestures(): Promise<void> {
    if (this.gestureBusy) return;
    const button = $('gesture');
    const help = $('gesture-help');
    const status = $('gesture-status');
    if (this.gestureOn) {
      this.gestureOn = false;
      this.tracker?.stop();
      this.releaseHands();
      button.setAttribute('aria-pressed', 'false');
      help.hidden = true;
      return;
    }
    this.gestureBusy = true;
    help.hidden = false;
    try {
      if (!(await this.handAssetsReady())) return;
      status.textContent = t.startingCamera;
      if (!this.tracker) {
        const { HandTracker } = await import('./hands');
        this.tracker = new HandTracker($<HTMLCanvasElement>('hands'));
        this.tracker.onResult = (result) => this.applyGestures(result);
      }
      const failure = await this.tracker.start();
      if (failure) {
        status.textContent = GESTURE_ERRORS[failure];
        return;
      }
      this.gestureOn = true;
      this.gestureMode = null;
      button.setAttribute('aria-pressed', 'true');
      status.textContent = GESTURE_STATUS.none;
    } catch {
      status.textContent = GESTURE_ERRORS['model-failed'];
    } finally {
      this.gestureBusy = false;
    }
  }

  /** True when tracking can start; otherwise offers the one-time download and leaves the rest to it. */
  private async handAssetsReady(): Promise<boolean> {
    const asset = await this.handAssetStatus();
    const download = $('gesture-download');
    if (!asset || asset.state === 'ready') {
      download.hidden = true;
      return true;
    }
    if (asset.state === 'downloading') {
      void this.followDownload();
      return false;
    }
    const size = Math.round(asset.totalBytes / 1e6);
    $('gesture-status').textContent =
      asset.state === 'failed' ? t.downloadFailed(asset.message) : t.downloadNeeded(size);
    download.textContent = asset.state === 'failed' ? t.retry : t.download;
    download.hidden = false;
    return false;
  }

  /** Null when the page isn't served by the plugin, as under `pnpm dev`. */
  private async handAssetStatus(method: 'GET' | 'POST' = 'GET'): Promise<HandAssetStatus | null> {
    try {
      const response = await fetch('api/hand-assets', { method });
      return response.ok ? ((await response.json()) as HandAssetStatus) : null;
    } catch {
      return null;
    }
  }

  private async followDownload(): Promise<void> {
    $('gesture-download').hidden = true;
    const status = $('gesture-status');
    for (;;) {
      const asset = await this.handAssetStatus();
      if (asset?.state !== 'downloading') {
        if (asset?.state === 'ready') void this.toggleGestures();
        else void this.handAssetsReady();
        return;
      }
      status.textContent = t.downloading(Math.floor((asset.received / asset.totalBytes) * 100));
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  private releaseHands(): void {
    this.holo.setHold('free');
    this.setHover(null);
    this.setHandHover(null);
    this.gestureMode = null;
    this.resetAim();
  }

  private resetAim(): void {
    this.aimTarget = null;
    this.aimFiredAt = null;
    this.tracker?.setAim(null);
  }

  private setHandHover(element: Element | null): void {
    if (element === this.handHover) return;
    this.handHover?.classList.remove('hand-hover');
    element?.classList.add('hand-hover');
    this.handHover = element;
  }

  private applyGestures({ mode, cursor, events }: GestureResult): void {
    if (mode !== this.gestureMode) {
      this.gestureMode = mode;
      $('gesture-status').textContent = GESTURE_STATUS[mode];
    }
    const now = performance.now();
    if (mode !== 'none') this.handSeenAt = now;
    // A raised hand is about to aim, so the idle spin stops as soon as one is seen.
    const idle = now - this.handSeenAt < HAND_GONE_MS ? 'still' : 'free';
    this.holo.setHold(mode === 'aim' ? 'aim' : mode === 'grab' || mode === 'zoom' ? 'drag' : idle);

    if (mode === 'aim' && cursor) {
      this.updateAim(cursor.x * window.innerWidth, cursor.y * window.innerHeight);
    } else {
      this.resetAim();
      this.setHover(null);
      this.setHandHover(null);
    }

    for (const event of events) {
      if (event.type === 'rotate') this.holo.rotateBy(event.dx, event.dy);
      else if (event.type === 'zoom') this.holo.zoomBy(event.factor);
      else this.deselect();
    }
  }

  /** What the finger is on; keeps the current node until the finger clearly leaves it. */
  private resolveAim(x: number, y: number): AimTarget | null {
    const element = document.elementFromPoint(x, y);
    // The language switch would end the gesture session, and removing a group can't be undone.
    const control = element?.closest('button:not(#language):not(.remove), a');
    if (control instanceof HTMLElement) return { key: control, dwell: DWELL_CONTROL_MS, node: null, control };
    if (element !== $('holo')) return null;

    const held = this.aimTarget?.node ?? null;
    let node = held;
    if (held !== null) {
      const p = this.holo.project(held);
      if (Math.hypot(p.x - x, p.y - y) > MAGNET_PX * 1.4) node = null;
    }
    node ??= this.holo.pick(x, y, MAGNET_PX);
    if (node !== null) return node === this.selected ? null : { key: node, dwell: DWELL_NODE_MS, node, control: null };
    return this.selected !== null ? { key: 'empty', dwell: DWELL_EMPTY_MS, node: null, control: null } : null;
  }

  private updateAim(x: number, y: number): void {
    if (this.aimFiredAt) {
      // The camera is flying after a selection, so nodes slide under a still finger.
      // Wait for the finger itself to move before arming again.
      if (Math.hypot(x - this.aimFiredAt.x, y - this.aimFiredAt.y) < REARM_PX) {
        this.tracker?.setAim({ x, y, progress: 0 });
        return;
      }
      this.aimFiredAt = null;
    }
    const target = this.resolveAim(x, y);
    const now = performance.now();
    if (target?.key !== this.aimTarget?.key) this.aimSince = now;
    this.aimTarget = target;
    this.setHover(target?.node ?? null);
    this.setHandHover(target?.control ?? null);
    if (!target) {
      this.tracker?.setAim({ x, y, progress: 0 });
      return;
    }
    const mark = target.node !== null ? this.holo.project(target.node) : { x, y };
    const progress = Math.min(1, (now - this.aimSince) / target.dwell);
    this.tracker?.setAim({ x: mark.x, y: mark.y, progress });
    if (progress < 1) return;

    this.aimFiredAt = { x, y };
    this.aimTarget = null;
    this.setHandHover(null);
    if (target.control) target.control.click();
    else if (target.node !== null) this.select(target.node);
    else this.deselect();
  }

  private bindControls(): void {
    $('gesture').addEventListener('click', () => void this.toggleGestures());
    $('language').addEventListener('click', switchLanguage);
    $('gesture-download').addEventListener('click', () => {
      void this.handAssetStatus('POST').then(() => this.followDownload());
    });
    this.search.addEventListener('input', () => this.runSearch(this.search.value));
    this.search.addEventListener('keydown', (e) => this.searchKey(e));
    $('close').addEventListener('click', () => this.deselect());
    document.querySelectorAll<HTMLButtonElement>('#layouts button').forEach((b) =>
      b.addEventListener('click', () => this.setLayout(b.dataset.layout as LayoutName)),
    );
    document.querySelectorAll<HTMLButtonElement>('#toggles button').forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        this.holo.setEdgeVisible(b.dataset.edge as EdgeKind, on);
      }),
    );
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.query) this.clearSearch();
        else this.deselect();
        return;
      }
      if (document.activeElement === this.search) return;
      if (e.key === '/') {
        e.preventDefault();
        this.search.focus();
      }
      const layout = ({ '1': 'cloud', '2': 'globe', '3': 'ring' } as Record<string, LayoutName>)[e.key];
      if (layout) this.setLayout(layout);
      if (e.key === 'g') void this.toggleGestures();
    });
  }

  private setLayout(name: LayoutName): void {
    document.querySelectorAll<HTMLButtonElement>('#layouts button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.layout === name)),
    );
    this.holo.setLayout(name);
  }

  private setHover(index: number | null): void {
    if (index === this.hover) return;
    this.hover = index;
    this.holo.setHover(index);
    $('holo').style.cursor = index === null ? 'grab' : 'pointer';
  }

  private runSearch(raw: string): void {
    this.query = raw.trim().toLowerCase();
    this.activeResult = -1;
    this.results.replaceChildren();
    if (!this.query) {
      this.clearSearch();
      return;
    }
    if (this.selected !== null) this.closePanel();
    const scored: [number, number][] = [];
    this.graph.nodes.forEach((n, i) => {
      const title = n.title.toLowerCase();
      const score = title.startsWith(this.query) ? 4 : title.includes(this.query) ? 3 : n.path.toLowerCase().includes(this.query) ? 2 : n.snippet.toLowerCase().includes(this.query) ? 1 : 0;
      if (score) scored.push([i, score]);
    });
    scored.sort((a, b) => b[1] - a[1]);
    this.matches = scored.map(([i]) => i);
    this.holo.showMatches(this.matches);
    this.labels = this.noteLabels(this.matches.slice(0, 6));

    if (this.matches.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = t.noMatches;
      this.results.append(li);
    }
    this.matches.slice(0, 7).forEach((index) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = this.graph.nodes[index].title;
      btn.addEventListener('click', () => this.select(index));
      li.append(btn);
      this.results.append(li);
    });
    this.results.hidden = false;
  }

  private searchKey(e: KeyboardEvent): void {
    const buttons = [...this.results.querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!buttons.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.activeResult = (this.activeResult + step + buttons.length) % buttons.length;
      buttons.forEach((b, i) => b.classList.toggle('active', i === this.activeResult));
    } else if (e.key === 'Enter' && buttons.length) {
      buttons[Math.max(this.activeResult, 0)].click();
    }
  }

  private clearSearch(): void {
    this.query = '';
    this.search.value = '';
    this.matches = [];
    this.results.hidden = true;
    this.results.replaceChildren();
    if (this.selected === null) this.restoreIdleView();
  }

  private noteLabels(indices: number[]): LabelItem[] {
    return indices.map((i) => ({
      text: this.graph.nodes[i].title,
      kind: 'note' as const,
      point: () => this.holo.project(i),
    }));
  }

  private select(index: number): void {
    this.selected = index;
    this.results.hidden = true;
    this.search.blur();
    const similar = this.graph.nodes[index].neighbours;
    const links = this.linkMap[index];
    const related = [...new Set([...similar.map(([j]) => j), ...links])];
    this.holo.select(index, related);
    this.labels = this.noteLabels(related.slice(0, 10));
    this.renderPanel(index, similar, links);
    document.body.classList.add('focused');
  }

  private closePanel(): void {
    this.selected = null;
    this.panel.hidden = true;
    document.body.classList.remove('focused');
  }

  private deselect(): void {
    if (this.selected === null) return;
    this.closePanel();
    if (this.query) {
      this.holo.clearFocus();
      this.runSearch(this.query);
    } else {
      this.restoreIdleView();
    }
  }

  private renderPanel(index: number, similar: [number, number][], links: number[]): void {
    const n = this.graph.nodes[index];
    const { vault } = this.graph.meta;
    $('note-title').textContent = n.title;
    $('note-path').textContent = n.path.replace(/\.md$/, '');
    const date = new Date(n.mtime).toLocaleDateString(dateLocale);
    $('note-meta').textContent = t.noteMeta([...(n.tag ? [`#${n.tag}`] : []), this.graph.clusters[n.cluster].label], n.chunks, date);
    $('note-snippet').textContent = n.snippet;
    $<HTMLAnchorElement>('note-open').href = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(n.path)}`;

    $('note-similar').replaceChildren(
      ...similar.map(([j, sim]) => this.relatedRow(j, sim)),
    );
    $('note-links').replaceChildren(...links.slice(0, 12).map((j) => this.relatedRow(j)));
    $('links-block').hidden = links.length === 0;
    this.panel.hidden = false;
    this.panel.scrollTop = 0;
  }

  private relatedRow(index: number, similarity?: number): HTMLLIElement {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const name = document.createElement('span');
    name.textContent = this.graph.nodes[index].title;
    btn.append(name);
    if (similarity !== undefined) {
      const value = document.createElement('span');
      value.className = 'sim';
      value.textContent = similarity.toFixed(2);
      btn.append(value);
      btn.setAttribute('aria-label', t.similarity(this.graph.nodes[index].title, similarity.toFixed(2)));
    }
    btn.addEventListener('click', () => this.select(index));
    li.append(btn);
    return li;
  }


  private labelEl(i: number): HTMLDivElement {
    if (!this.labelEls[i]) {
      const el = document.createElement('div');
      el.className = 'label';
      this.labelBox.append(el);
      this.labelEls[i] = el;
    }
    return this.labelEls[i];
  }

  private updateLabels(): void {
    if (!this.booted) {
      if (this.holo.morphing) return;
      this.booted = true;
    }
    const items: LabelItem[] = [...this.labels];
    if (this.hover !== null && this.hover !== this.selected) {
      const i = this.hover;
      items.unshift({ text: this.graph.nodes[i].title, kind: 'hover', point: () => this.holo.project(i) });
    }
    const placed: { x: number; y: number; w: number }[] = [];
    items.forEach((item, i) => {
      const el = this.labelEl(i);
      if (el.dataset.text !== item.text) {
        el.dataset.text = item.text;
        el.textContent = item.text;
        el.dataset.w = String(el.offsetWidth || item.text.length * 13);
      }
      el.dataset.kind = item.kind;
      const p = item.point();
      let y = p.y - 8;
      const x = p.x + (item.kind === 'cluster' ? 0 : 12);
      const w = Number(el.dataset.w) || 120;
      for (let guard = 0; guard < 12; guard++) {
        const hit = placed.some((b) => Math.abs(b.y - y) < 19 && x < b.x + b.w && b.x < x + w);
        if (!hit) break;
        y += 19;
      }
      placed.push({ x, y, w });
      const depth = item.kind === 'hover' ? 1 : Math.max(0.68, Math.min(1, 0.85 + p.nearness / 200));
      el.style.opacity = p.visible ? String(depth) : '0';
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    });
    for (let i = items.length; i < this.labelEls.length; i++) this.labelEls[i].style.opacity = '0';
  }
}

async function start(): Promise<void> {
  translatePage();
  if (!webglAvailable()) {
    showError(t.noWebgl);
    return;
  }
  const [graph, legend] = await Promise.all([loadGraph(), loadLegend()]);
  if (!graph) return;
  await document.fonts.ready;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const holo = new Hologram($<HTMLCanvasElement>('holo'), graph, reduced);
  new Interface(holo, graph, legend.saved, legend.persists);
}

void start();
