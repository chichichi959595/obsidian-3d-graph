import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { EdgeKind, Graph, LayoutName, ScreenPoint } from './types';

const BACKGROUND = '#0f1217';
const DOT = '#e6ebf1';
const AMBER = '#ffb347';
const HOME_TARGET = new THREE.Vector3(0, 0, 0);
const HOME_DISTANCE = 345;
const FOCUS_DISTANCE = 150;
const MAX_HIGHLIGHTS = 40;

/** `drag` stops idle spin while the hand steers; `aim` freezes all motion so a target stays put. */
export type HandHold = 'free' | 'still' | 'drag' | 'aim';

const nodeVertex = /* glsl */ `
  attribute float aSize, aState, aIndex;
  attribute vec3 aColor;
  uniform float uPx, uFocus, uHover, uCamDist;
  uniform vec3 uAmber;
  varying vec3 vColor;
  varying float vAlpha, vEdge;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    bool primary = aState > 1.5;
    bool related = aState > 0.5 && !primary;
    bool hover = abs(aIndex - uHover) < 0.5;
    vColor = primary ? uAmber : related ? mix(aColor, vec3(1.0), 0.2) : aColor;
    // Farther dots fade, which is the only depth cue besides parallax.
    float fog = mix(1.0, 0.35, clamp((-mv.z - uCamDist) / 240.0 + 0.5, 0.0, 1.0));
    vAlpha = (primary || related || hover) ? 1.0 : fog * mix(1.0, 0.16, uFocus);
    float grow = primary ? 1.9 : (related || hover) ? 1.4 : 1.0;
    float size = aSize * grow * uPx * sqrt(340.0 / -mv.z);
    gl_PointSize = size + 1.5;
    vEdge = 3.0 / gl_PointSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const nodeFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha, vEdge;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(vColor, (1.0 - smoothstep(1.0 - vEdge, 1.0, d)) * vAlpha);
    #include <colorspace_fragment>
  }
`;

/** WebGL ignores line width, so each edge is a quad widened in screen space. */
const lineVertexCommon = /* glsl */ `
  attribute vec3 aStart, aEnd;
  uniform vec2 uViewport;
  void placeLine(float width) {
    vec4 a = projectionMatrix * modelViewMatrix * vec4(aStart, 1.0);
    vec4 b = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);
    // Close to a note, an edge can pass behind the camera, where the perspective divide flips it.
    const float NEAR = 0.1;
    if (a.w < NEAR && b.w < NEAR) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (a.w < NEAR) a = mix(a, b, (NEAR - a.w) / (b.w - a.w));
    else if (b.w < NEAR) b = mix(b, a, (NEAR - b.w) / (a.w - b.w));
    vec2 along = (b.xy / b.w - a.xy / a.w) * uViewport;
    float len = length(along);
    vec2 normal = len > 1e-4 ? vec2(-along.y, along.x) / len : vec2(0.0);
    vec4 p = mix(a, b, position.x);
    p.xy += normal * position.y * width / uViewport * p.w;
    gl_Position = p;
  }
`;

const edgeVertex = /* glsl */ `
  ${lineVertexCommon}
  attribute float aKind, aLen, aLit;
  uniform vec2 uShow;
  uniform float uFocus;
  varying float vKind, vShow, vLen, vLit;
  void main() {
    vKind = aKind; vLen = aLen;
    vShow = aKind > 0.5 ? uShow.y : uShow.x;
    vLit = aLit * uFocus;
    placeLine(mix(aKind > 0.5 ? 1.7 : 1.3, 3.0, vLit));
  }
`;

const edgeFragment = /* glsl */ `
  uniform float uFocus;
  uniform vec3 uDot;
  varying float vKind, vShow, vLen, vLit;
  void main() {
    if (vShow < 0.01) discard;
    float base = vKind > 0.5 ? 0.2 : 0.09;
    // Long edges cross the whole figure; fading them keeps the local structure readable.
    float reach = mix(0.12, 1.0, smoothstep(150.0, 42.0, vLen));
    gl_FragColor = vec4(uDot, mix(base * reach * mix(1.0, 0.12, uFocus), 0.75, vLit) * vShow);
    #include <colorspace_fragment>
  }
`;

const highlightFragment = /* glsl */ `
  uniform float uFocus;
  uniform vec3 uAmber;
  void main() {
    gl_FragColor = vec4(uAmber, 0.85 * uFocus);
    #include <colorspace_fragment>
  }
`;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function flat(params: THREE.ShaderMaterialParameters): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, ...params });
}

interface LineSet {
  geometry: THREE.InstancedBufferGeometry;
  /** Six numbers per line: its two endpoints. */
  ends: THREE.InstancedInterleavedBuffer;
}

function createLineSet(count: number): LineSet {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  const ends = new THREE.InstancedInterleavedBuffer(new Float32Array(count * 6), 6, 1);
  geometry.setAttribute('aStart', new THREE.InterleavedBufferAttribute(ends, 3, 0));
  geometry.setAttribute('aEnd', new THREE.InterleavedBufferAttribute(ends, 3, 3));
  geometry.instanceCount = count;
  return { geometry, ends };
}

export class Hologram {
  readonly camera: THREE.PerspectiveCamera;
  onFrame: () => void = () => {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();

  private readonly count: number;
  private readonly pos: Float32Array;
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly delay: Float32Array;
  private morphT = 1;

  private readonly nodeGeo = new THREE.BufferGeometry();
  private readonly edges: LineSet;
  private readonly highlights = createLineSet(MAX_HIGHLIGHTS);
  private readonly edgePairs: [number, number][];
  private readonly nodeState: Float32Array;

  private readonly shared = {
    uFocus: { value: 0 },
    uHover: { value: -1 },
    uPx: { value: 1 },
    uCamDist: { value: HOME_DISTANCE },
    uDot: { value: new THREE.Color(DOT) },
    uAmber: { value: new THREE.Color(AMBER) },
  };
  private readonly viewport = { value: new THREE.Vector2(1, 1) };
  private readonly edgeShow = { value: new THREE.Vector2(1, 1) };
  private readonly edgeShowTarget = new THREE.Vector2(1, 1);

  private focusTarget = 0;
  private selected: number | null = null;
  private highlighted: number[] = [];
  private returning = false;
  private flyDistance: number | null = null;
  private hold: HandHold = 'free';
  /** Hand motion not yet applied, plus the velocity that carries on after release. */
  private readonly handMotion = { theta: 0, phi: 0, zoom: 0, vTheta: 0, vPhi: 0 };
  private readonly spherical = new THREE.Spherical();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly graph: Graph,
    private readonly reducedMotion: boolean,
  ) {
    this.count = graph.nodes.length;
    this.pos = new Float32Array(graph.layouts.cloud);
    this.from = new Float32Array(this.count * 3);
    this.to = new Float32Array(graph.layouts.cloud);
    this.delay = new Float32Array(this.count);
    this.nodeState = new Float32Array(this.count);
    this.edgePairs = [...graph.edges.semantic, ...graph.edges.links];
    this.edges = createLineSet(this.edgePairs.length);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(BACKGROUND, 1);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 3000);
    this.camera.position.set(0, 40, HOME_DISTANCE);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 620;
    this.controls.autoRotate = !reducedMotion;
    this.controls.autoRotateSpeed = 0.28;

    this.buildEdges();
    this.buildHighlights();
    this.buildNodes();

    window.addEventListener('resize', this.resize);
    this.resize();
    this.writePositions();
    this.renderer.setAnimationLoop(this.tick);
  }

  private buildNodes(): void {
    const links = new Uint16Array(this.count);
    for (const [a, b] of this.graph.edges.links) {
      links[a]++;
      links[b]++;
    }
    const size = new Float32Array(this.count);
    const index = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      // Square root, as in Obsidian's graph: a hub stands out without dwarfing everything.
      size[i] = Math.min(2.6 + Math.sqrt(links[i]) * 1.8, 17);
      index[i] = i;
    }
    this.nodeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    this.nodeGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.nodeGeo.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    this.nodeGeo.setAttribute('aState', new THREE.BufferAttribute(this.nodeState, 1));
    this.nodeGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    const points = new THREE.Points(
      this.nodeGeo,
      flat({ vertexShader: nodeVertex, fragmentShader: nodeFragment, uniforms: this.shared }),
    );
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.scene.add(points);
  }

  private buildEdges(): void {
    const m = this.edgePairs.length;
    const semanticCount = this.graph.edges.semantic.length;
    const kind = new Float32Array(m);
    kind.fill(1, semanticCount);
    this.edges.geometry.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
    this.edges.geometry.setAttribute('aLen', new THREE.InstancedBufferAttribute(new Float32Array(m), 1));
    this.edges.geometry.setAttribute('aLit', new THREE.InstancedBufferAttribute(new Float32Array(m), 1));
    const lines = new THREE.Mesh(
      this.edges.geometry,
      flat({
        vertexShader: edgeVertex,
        fragmentShader: edgeFragment,
        uniforms: { uFocus: this.shared.uFocus, uDot: this.shared.uDot, uShow: this.edgeShow, uViewport: this.viewport },
      }),
    );
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    this.scene.add(lines);
  }

  private buildHighlights(): void {
    this.highlights.geometry.instanceCount = 0;
    const lines = new THREE.Mesh(
      this.highlights.geometry,
      flat({
        vertexShader: /* glsl */ `${lineVertexCommon} void main() { placeLine(2.6); }`,
        fragmentShader: highlightFragment,
        uniforms: { uFocus: this.shared.uFocus, uAmber: this.shared.uAmber, uViewport: this.viewport },
      }),
    );
    lines.frustumCulled = false;
    lines.renderOrder = 2;
    this.scene.add(lines);
  }

  private readonly resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 58 : 40;
    this.camera.updateProjectionMatrix();
    this.shared.uPx.value = dpr * Math.max(h / 900, 0.8);
    this.viewport.value.set(w, h);
  };

  private writePositions(): void {
    const nodes = this.nodeGeo.getAttribute('position') as THREE.BufferAttribute;
    (nodes.array as Float32Array).set(this.pos);
    nodes.needsUpdate = true;

    const e = this.edges.ends.array as Float32Array;
    const lengths = this.edges.geometry.getAttribute('aLen') as THREE.InstancedBufferAttribute;
    const len = lengths.array as Float32Array;
    this.edgePairs.forEach(([a, b], i) => {
      const k = i * 6;
      e[k] = this.pos[a * 3];
      e[k + 1] = this.pos[a * 3 + 1];
      e[k + 2] = this.pos[a * 3 + 2];
      e[k + 3] = this.pos[b * 3];
      e[k + 4] = this.pos[b * 3 + 1];
      e[k + 5] = this.pos[b * 3 + 2];
      len[i] = Math.hypot(e[k] - e[k + 3], e[k + 1] - e[k + 4], e[k + 2] - e[k + 5]);
    });
    this.edges.ends.needsUpdate = true;
    lengths.needsUpdate = true;
    this.writeHighlights();
  }

  private writeHighlights(): void {
    const h = this.highlights.ends.array as Float32Array;
    const s = this.selected;
    if (s === null) {
      this.highlights.geometry.instanceCount = 0;
      return;
    }
    const list = this.highlighted.slice(0, MAX_HIGHLIGHTS);
    list.forEach((j, i) => {
      const k = i * 6;
      h[k] = this.pos[s * 3];
      h[k + 1] = this.pos[s * 3 + 1];
      h[k + 2] = this.pos[s * 3 + 2];
      h[k + 3] = this.pos[j * 3];
      h[k + 4] = this.pos[j * 3 + 1];
      h[k + 5] = this.pos[j * 3 + 2];
    });
    this.highlights.ends.needsUpdate = true;
    this.highlights.geometry.instanceCount = list.length;
  }

  private readonly tick = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.morphT < 1) {
      this.morphT = this.reducedMotion ? 1 : Math.min(1, this.morphT + dt / 1.2);
      for (let i = 0; i < this.count; i++) {
        const local = easeInOut(clamp01((this.morphT - this.delay[i]) / 0.8));
        for (let c = 0; c < 3; c++) {
          const k = i * 3 + c;
          this.pos[k] = this.from[k] + (this.to[k] - this.from[k]) * local;
        }
      }
      this.writePositions();
    }

    const rate = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    this.shared.uFocus.value += (this.focusTarget - this.shared.uFocus.value) * rate;
    this.edgeShow.value.lerp(this.edgeShowTarget, rate);

    this.updateCameraGoal(dt);
    this.applyHandMotion(dt);
    this.controls.update(dt);
    this.shared.uCamDist.value = this.camera.position.distanceTo(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.onFrame();
  };

  private updateCameraGoal(dt: number): void {
    const glide = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.6);
    const goal = this.selected !== null ? this.tmp.fromArray(this.pos, this.selected * 3) : this.returning ? this.tmp.copy(HOME_TARGET) : null;
    if (goal) {
      const delta = this.tmp2.copy(goal).sub(this.controls.target).multiplyScalar(glide);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      if (this.returning && this.controls.target.distanceTo(HOME_TARGET) < 0.2) this.returning = false;
    }
    if (this.flyDistance !== null) {
      const offset = this.tmp2.copy(this.camera.position).sub(this.controls.target);
      const next = offset.length() + (this.flyDistance - offset.length()) * glide;
      offset.setLength(next);
      this.camera.position.copy(this.controls.target).add(offset);
      if (Math.abs(next - this.flyDistance) < 0.5) this.flyDistance = null;
    }
  }

  private applyHandMotion(dt: number): void {
    const h = this.handMotion;
    const take = 1 - Math.exp(-dt * 16);
    const dTheta = h.theta * take;
    const dPhi = h.phi * take;
    const dZoom = h.zoom * take;
    h.theta -= dTheta;
    h.phi -= dPhi;
    h.zoom -= dZoom;

    let theta = dTheta;
    let phi = dPhi;
    if (this.hold === 'drag' && dt > 0) {
      h.vTheta += (dTheta / dt - h.vTheta) * 0.25;
      h.vPhi += (dPhi / dt - h.vPhi) * 0.25;
    } else if (this.reducedMotion) {
      h.vTheta = h.vPhi = 0;
    } else {
      theta += h.vTheta * dt;
      phi += h.vPhi * dt;
      const decay = Math.exp(-dt * 2.8);
      h.vTheta *= decay;
      h.vPhi *= decay;
    }
    if (Math.abs(theta) + Math.abs(phi) + Math.abs(dZoom) < 1e-6) return;

    const offset = this.tmp2.copy(this.camera.position).sub(this.controls.target);
    this.spherical.setFromVector3(offset);
    this.spherical.theta -= theta;
    this.spherical.phi = Math.min(Math.PI - 0.12, Math.max(0.12, this.spherical.phi - phi));
    this.spherical.radius = Math.min(
      this.controls.maxDistance,
      Math.max(this.controls.minDistance, this.spherical.radius / Math.exp(dZoom)),
    );
    offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  /** Rotate by a fraction of a full turn, in the same directions as dragging with a mouse. */
  rotateBy(turnsX: number, turnsY: number): void {
    if (this.hold === 'aim') return;
    this.handMotion.theta += turnsX * Math.PI * 2;
    this.handMotion.phi += turnsY * Math.PI * 2;
  }

  /** A factor above 1 moves closer. */
  zoomBy(factor: number): void {
    this.handMotion.zoom += Math.log(factor);
    this.flyDistance = null;
  }

  setHold(hold: HandHold): void {
    if (hold === this.hold) return;
    this.hold = hold;
    if (hold === 'aim') {
      const h = this.handMotion;
      h.theta = h.phi = h.vTheta = h.vPhi = 0;
    }
    this.syncAutoRotate();
  }

  private syncAutoRotate(): void {
    this.controls.autoRotate = !this.reducedMotion && this.selected === null && this.hold === 'free';
  }

  get morphing(): boolean {
    return this.morphT < 1;
  }

  setLayout(name: LayoutName): void {
    this.from.set(this.pos);
    this.to.set(this.graph.layouts[name]);
    const k = this.graph.clusters.length;
    this.graph.nodes.forEach((n, i) => (this.delay[i] = (n.cluster / k) * 0.2));
    this.morphT = 0;
  }

  setEdgeVisible(kind: EdgeKind, visible: boolean): void {
    if (kind === 'semantic') this.edgeShowTarget.x = visible ? 1 : 0;
    else this.edgeShowTarget.y = visible ? 1 : 0;
  }

  /** `colors` is one CSS colour per note. */
  setNodeColors(colors: string[]): void {
    const attr = this.nodeGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const color = new THREE.Color();
    colors.forEach((css, i) => color.set(css).toArray(out, i * 3));
    attr.needsUpdate = true;
  }

  setHover(index: number | null): void {
    this.shared.uHover.value = index ?? -1;
  }

  /** Light one note and its relatives; everything else recedes. */
  select(index: number, related: number[]): void {
    this.selected = index;
    this.highlighted = related;
    this.returning = false;
    this.flyDistance = FOCUS_DISTANCE;
    this.syncAutoRotate();
    this.paint(index, related);
    this.writeHighlights();
  }

  /** Light matches without moving the camera, as search narrows. */
  showMatches(matches: number[]): void {
    this.selected = null;
    this.highlighted = [];
    this.paint(null, matches);
    this.writeHighlights();
  }

  clearFocus(): void {
    const hadSelection = this.selected !== null;
    this.selected = null;
    this.highlighted = [];
    this.paint(null, []);
    this.writeHighlights();
    if (hadSelection) {
      this.returning = true;
      this.flyDistance = HOME_DISTANCE;
      this.syncAutoRotate();
    }
  }

  private paint(primary: number | null, related: number[]): void {
    this.nodeState.fill(0);
    for (const j of related) this.nodeState[j] = 1;
    if (primary !== null) this.nodeState[primary] = 2;
    this.focusTarget = primary !== null || related.length > 0 ? 1 : 0;
    this.nodeGeo.getAttribute('aState').needsUpdate = true;

    // A selection already draws its own connections; a group or search shows those inside it.
    const lit = this.edges.geometry.getAttribute('aLit') as THREE.InstancedBufferAttribute;
    const glow = lit.array as Float32Array;
    this.edgePairs.forEach(([a, b], i) => (glow[i] = primary === null && this.nodeState[a] > 0 && this.nodeState[b] > 0 ? 1 : 0));
    lit.needsUpdate = true;
  }

  project(index: number): ScreenPoint {
    return this.projectVector(this.tmp.fromArray(this.pos, index * 3));
  }

  clusterCentre(cluster: number): ScreenPoint {
    const c = new THREE.Vector3();
    let n = 0;
    this.graph.nodes.forEach((node, i) => {
      if (node.cluster !== cluster) return;
      c.x += this.pos[i * 3];
      c.y += this.pos[i * 3 + 1];
      c.z += this.pos[i * 3 + 2];
      n++;
    });
    return this.projectVector(c.divideScalar(Math.max(n, 1)));
  }

  private projectVector(v: THREE.Vector3): ScreenPoint {
    const nearness = this.camera.position.distanceTo(this.controls.target) - this.camera.position.distanceTo(v);
    v.project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      visible: v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05,
      nearness,
    };
  }

  pick(x: number, y: number, radius = 16): number | null {
    let best: number | null = null;
    let bestScore = radius * radius;
    for (let i = 0; i < this.count; i++) {
      const p = this.project(i);
      if (!p.visible) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestScore) {
        bestScore = d;
        best = i;
      }
    }
    return best;
  }
}
