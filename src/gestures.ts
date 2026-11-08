/** Turns per-frame hand landmarks into intent. Pure logic: no camera, DOM or rendering. */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface HandInput {
  /** Normalised camera coordinates, unmirrored. */
  image: Point3[];
  /** Metric coordinates around the hand; unaffected by distance from the camera. */
  world: Point3[];
}

export type GestureEvent =
  | { type: 'rotate'; dx: number; dy: number }
  | { type: 'zoom'; factor: number }
  /** A closed fist sprang open into five spread fingers. */
  | { type: 'burst' };

/** `open` is a tracked hand doing nothing; `aim` is an extended index finger. */
export type GestureMode = 'none' | 'open' | 'aim' | 'grab' | 'zoom';

export interface GestureResult {
  mode: GestureMode;
  cursor: { x: number; y: number } | null;
  events: GestureEvent[];
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
/** Middle, ring and little finger as [PIP, tip]. */
const FOLDING_FINGERS = [
  [10, 12],
  [14, 16],
  [18, 20],
] as const;

/** All four fingers as [PIP, tip]. */
const ALL_FINGERS = [[6, 8], ...FOLDING_FINGERS] as const;

/** How far past the knuckle the resting cursor sits, as a fraction of wrist-to-knuckle length. */
const PALM_REACH = 0.75;
/** Fingertip gap relative to palm length. The gap between the two values prevents flicker. */
const PINCH_ENTER = 0.2;
const PINCH_EXIT = 0.34;
/** Knuckle-to-tip span over wrist-to-knuckle length, above which the index counts as extended. */
const INDEX_EXTENDED = 0.62;
/** Consecutive frames a pose must disagree before it changes; hides single-frame tracking dropouts. */
const RELEASE_FRAMES = 2;
const POINT_FRAMES = 3;
/** Real hands drop out of the pointing pose for moments; a dwell has to survive that. */
const AIM_RELEASE_MS = 350;
/** A fist must be held this long, then open within the window, to count as a burst. */
const FIST_MS = 150;
const BURST_WINDOW_MS = 450;
/** Tip-to-wrist over knuckle-joint-to-wrist; above this a finger is straight rather than relaxed. */
const FINGER_STRAIGHT = 1.12;
/** Thumb-to-index gap, relative to palm length, that counts as the thumb being flung out. */
const THUMB_SPREAD = 0.55;
const LOST_MS = 200;
const MATCH_RADIUS = 0.35;
/** The outer part of the camera view is hard to reach, so the screen maps to its inner area. */
const REACH_MARGIN = 0.1;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function dist(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Map a camera point to mirrored 0..1 screen space, so the hand moves like a reflection. */
function toReach(x: number, y: number): { x: number; y: number } {
  const span = 1 - 2 * REACH_MARGIN;
  return {
    x: clamp01((1 - x - REACH_MARGIN) / span),
    y: clamp01((y - REACH_MARGIN) / span),
  };
}

/** One Euro filter: steady when the hand is still, responsive when it moves. */
class OneEuro {
  private value: number | null = null;
  private speed = 0;
  private time = 0;

  next(input: number, t: number): number {
    if (this.value === null) {
      this.value = input;
      this.time = t;
      return input;
    }
    const dt = Math.max((t - this.time) / 1000, 1e-3);
    this.time = t;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.speed += alpha(1) * ((input - this.value) / dt - this.speed);
    this.value += alpha(1.2 + 6 * Math.abs(this.speed)) * (input - this.value);
    return this.value;
  }
}

interface Slot {
  wrist: Point3;
  seen: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  fx: OneEuro;
  fy: OneEuro;
  pinching: boolean;
  apartFrames: number;
  pointing: boolean;
  /** Frames the raw pointing pose has disagreed with `pointing`. */
  pointFrames: number;
  /** When the raw pose stopped being a point while `pointing` was still on. */
  pointMissSince: number | null;
  /** Whether the cursor last followed the fingertip rather than the palm. */
  onFingertip: boolean;
  fistSince: number | null;
  /** Last moment a sufficiently held fist was seen; 0 when none is waiting to open. */
  fistSeenAt: number;
}

function isPointingPose(world: Point3[], gap: number): boolean {
  const palm = Math.max(dist(world[WRIST], world[INDEX_MCP]), 1e-4);
  const extended =
    dist(world[INDEX_MCP], world[INDEX_TIP]) / palm > INDEX_EXTENDED &&
    dist(world[INDEX_TIP], world[WRIST]) > dist(world[INDEX_PIP], world[WRIST]);
  const othersFolded = FOLDING_FINGERS.every(([pip, tip]) => dist(world[tip], world[WRIST]) < dist(world[pip], world[WRIST]));
  return extended && othersFolded && gap >= PINCH_EXIT;
}

export class GestureInterpreter {
  private slots: Slot[] = [];
  private primary: Slot | null = null;
  private zoomGap = 0;

  update(hands: HandInput[], t: number): GestureResult {
    const events: GestureEvent[] = [];
    const live = this.match(hands, t);
    this.slots = this.slots.filter((s) => t - s.seen <= LOST_MS);

    for (const slot of this.slots) slot.dx = slot.dy = 0;
    for (const [slot, hand] of live) this.advance(slot, hand, t, events);

    // Includes hands missed for a frame or two, so a tracking dropout doesn't end the gesture.
    const seen = this.slots;
    const pinching = seen.filter((s) => s.pinching);
    const pointing = seen.find((s) => s.pointing);

    let mode: GestureMode = seen.length ? 'open' : 'none';
    if (pinching.length >= 2) {
      mode = 'zoom';
      const [a, b] = pinching;
      const gap = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 0.01);
      if (this.zoomGap > 0 && Math.abs(gap / this.zoomGap - 1) > 0.002) {
        events.push({ type: 'zoom', factor: gap / this.zoomGap });
      }
      this.zoomGap = gap;
    } else {
      this.zoomGap = 0;
      // Aiming outranks grabbing, so a second hand can't move the target out from under the finger.
      if (pointing) mode = 'aim';
      else if (pinching.length === 1) {
        mode = 'grab';
        if (pinching[0].dx || pinching[0].dy) events.push({ type: 'rotate', dx: pinching[0].dx, dy: pinching[0].dy });
      }
    }

    if (mode === 'aim') this.primary = pointing ?? null;
    else if (pinching.length) this.primary = pinching[0];
    else if (!this.primary || !seen.includes(this.primary)) this.primary = seen[0] ?? null;
    return { mode, cursor: this.primary ? { x: this.primary.x, y: this.primary.y } : null, events };
  }

  private match(hands: HandInput[], t: number): [Slot, HandInput][] {
    const free = new Set(this.slots);
    return hands.map((hand) => {
      const wrist = hand.image[WRIST];
      let best: Slot | null = null;
      let bestDist = MATCH_RADIUS;
      for (const s of free) {
        const d = Math.hypot(s.wrist.x - wrist.x, s.wrist.y - wrist.y);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      const slot = best ?? this.createSlot(wrist);
      free.delete(slot);
      slot.wrist = wrist;
      slot.seen = t;
      return [slot, hand];
    });
  }

  private createSlot(wrist: Point3): Slot {
    const slot: Slot = {
      wrist,
      seen: 0,
      x: Number.NaN,
      y: Number.NaN,
      dx: 0,
      dy: 0,
      fx: new OneEuro(),
      fy: new OneEuro(),
      pinching: false,
      apartFrames: 0,
      pointing: false,
      pointFrames: 0,
      pointMissSince: null,
      onFingertip: false,
      fistSince: null,
      fistSeenAt: 0,
    };
    this.slots.push(slot);
    return slot;
  }

  private detectBurst(s: Slot, world: Point3[], gap: number, t: number, events: GestureEvent[]): void {
    const reach = (pip: number, tip: number) => dist(world[tip], world[WRIST]) / Math.max(dist(world[pip], world[WRIST]), 1e-4);
    // A thumb resting on the index fingertip is a pinch with curled fingers, not a fist.
    if (!s.pinching && ALL_FINGERS.every(([pip, tip]) => reach(pip, tip) < 1)) {
      s.fistSince ??= t;
      if (t - s.fistSince >= FIST_MS) s.fistSeenAt = t;
      return;
    }
    s.fistSince = null;
    const spread = gap > THUMB_SPREAD && ALL_FINGERS.every(([pip, tip]) => reach(pip, tip) > FINGER_STRAIGHT);
    if (spread && s.fistSeenAt > 0 && t - s.fistSeenAt <= BURST_WINDOW_MS) {
      s.fistSeenAt = 0;
      events.push({ type: 'burst' });
    }
  }

  private advance(s: Slot, hand: HandInput, t: number, events: GestureEvent[]): void {
    const { world, image } = hand;
    const gap = dist(world[THUMB_TIP], world[INDEX_TIP]) / Math.max(dist(world[WRIST], world[MIDDLE_MCP]), 1e-4);

    if (!s.pinching) {
      s.pinching = gap < PINCH_ENTER;
      s.apartFrames = 0;
    } else if (gap >= PINCH_EXIT) {
      s.apartFrames += 1;
      if (s.apartFrames >= RELEASE_FRAMES) s.pinching = false;
    } else {
      s.apartFrames = 0;
    }

    this.detectBurst(s, world, gap, t, events);

    const pose = !s.pinching && isPointingPose(world, gap);
    if (s.pinching) {
      s.pointing = false;
      s.pointFrames = 0;
      s.pointMissSince = null;
    } else if (pose) {
      s.pointMissSince = null;
      s.pointFrames = s.pointing ? 0 : s.pointFrames + 1;
      if (s.pointFrames >= POINT_FRAMES) {
        s.pointing = true;
        s.pointFrames = 0;
      }
    } else {
      s.pointFrames = 0;
      if (s.pointing) {
        s.pointMissSince ??= t;
        if (t - s.pointMissSince >= AIM_RELEASE_MS) {
          s.pointing = false;
          s.pointMissSince = null;
        }
      }
    }

    // Pinching leaves the palm where it is, so the palm is the steady reference for grabbing;
    // when aiming, the fingertip is what the person is actually looking along.
    const anchor = s.pointing
      ? toReach(image[INDEX_TIP].x, image[INDEX_TIP].y)
      : toReach(
          image[INDEX_MCP].x + (image[INDEX_MCP].x - image[WRIST].x) * PALM_REACH,
          image[INDEX_MCP].y + (image[INDEX_MCP].y - image[WRIST].y) * PALM_REACH,
        );
    // The two anchors sit apart, and that jump must not read as the hand moving.
    if (s.onFingertip !== s.pointing) {
      s.onFingertip = s.pointing;
      s.fx = new OneEuro();
      s.fy = new OneEuro();
      s.x = s.y = Number.NaN;
    }
    const first = Number.isNaN(s.x);
    const prevX = s.x;
    const prevY = s.y;
    s.x = s.fx.next(anchor.x, t);
    s.y = s.fy.next(anchor.y, t);
    s.dx = first ? 0 : s.x - prevX;
    s.dy = first ? 0 : s.y - prevY;
  }
}
