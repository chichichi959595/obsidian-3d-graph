import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { GestureInterpreter, type GestureResult, type HandInput, type Point3 } from './gestures';

const ICE = '230, 235, 241';
const AMBER = '#ffb347';
const RING = 20;

export interface AimMark {
  x: number;
  y: number;
  progress: number;
}

export type HandTrackerError = 'camera-denied' | 'camera-missing' | 'model-failed';

function failureOf(error: unknown): HandTrackerError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'camera-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'camera-missing';
  return 'model-failed';
}

async function createLandmarker(): Promise<HandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', location.href).href);
  const build = (delegate: 'GPU' | 'CPU') =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('models/hand_landmarker.task', location.href).href, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
  return build('GPU').catch(() => build('CPU'));
}

/** Camera, hand model and the on-screen cursor. Frames never leave the browser. */
export class HandTracker {
  onResult: (result: GestureResult) => void = () => {};

  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private readonly video = document.createElement('video');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly interpreter = new GestureInterpreter();
  private frame = 0;
  private lastVideoTime = -1;
  private lastStamp = 0;
  private cursor: GestureResult['cursor'] = null;
  private aim: AimMark | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.video.muted = true;
    this.video.playsInline = true;
  }

  /** Resolves to null once tracking runs, or to the reason it could not start. */
  async start(): Promise<HandTrackerError | null> {
    try {
      this.landmarker ??= await createLandmarker();
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (error) {
      this.stop();
      return failureOf(error);
    }
    window.addEventListener('resize', this.fit);
    this.fit();
    this.frame = requestAnimationFrame(this.loop);
    return null;
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.fit);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this.cursor = null;
    this.aim = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private readonly fit = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  private readonly loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    if (this.landmarker && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      // The model requires strictly increasing timestamps.
      this.lastStamp = Math.max(performance.now(), this.lastStamp + 1);
      this.consume(this.detect(this.landmarker), this.lastStamp);
    }
    this.draw();
  };

  private detect(landmarker: HandLandmarker): HandInput[] {
    const found = landmarker.detectForVideo(this.video, this.lastStamp);
    return found.landmarks.map((image, i) => ({
      image: image as Point3[],
      world: found.worldLandmarks[i] as Point3[],
    }));
  }

  private consume(hands: HandInput[], stamp: number): void {
    const result = this.interpreter.update(hands, stamp);
    this.cursor = result.cursor;
    this.onResult(result);
  }

  private draw(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (this.cursor) this.drawCursor(this.cursor);
  }

  /** The aim point (a snapped node, or the fingertip) and how far its dwell has filled, 0..1. */
  setAim(aim: AimMark | null): void {
    this.aim = aim;
  }

  private drawCursor(cursor: NonNullable<GestureResult['cursor']>): void {
    const { ctx } = this;
    const x = cursor.x * window.innerWidth;
    const y = cursor.y * window.innerHeight;
    if (!this.aim) {
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${ICE}, 0.5)`;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      return;
    }
    const { x: ax, y: ay, progress } = this.aim;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${ICE})`;
    ctx.fill();
    if (Math.hypot(ax - x, ay - y) > 4) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = `rgba(${ICE}, 0.45)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(ax, ay, RING, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${ICE}, 0.35)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(ax, ay, RING, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}
