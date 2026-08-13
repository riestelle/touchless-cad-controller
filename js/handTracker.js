// handTracker.js
//
// Wraps MediaPipe's HandLandmarker (Tasks Vision API) so the rest of the app
// just gets a simple list of hands, each with 21 normalized {x, y, z}
// landmarks and a Left/Right label.
//
// This runs entirely in the browser via WebAssembly. Nothing is installed
// on your machine: the WASM runtime (~2 MB) and the hand-tracking model
// (~10 MB) are fetched from a CDN the first time the app runs, then cached
// by the browser for every run after that.

import {
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

// Hand skeleton connections (MediaPipe's 21-point hand model) for drawing.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                 // palm base
];

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this._lastTimestampMs = 0;
  }

  // Loads the WASM runtime and model, and creates the landmarker.
  // Tries the GPU delegate first (faster) and falls back to CPU if the
  // browser/GPU combination doesn't support it.
  async init({
    maxHands = 2,
    detectionConfidence = 0.6,
    presenceConfidence = 0.6,
    trackingConfidence = 0.6,
  } = {}) {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    const options = {
      runningMode: "VIDEO",
      numHands: maxHands,
      minHandDetectionConfidence: detectionConfidence,
      minHandPresenceConfidence: presenceConfidence,
      minTrackingConfidence: trackingConfidence,
    };

    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
    } catch (err) {
      console.warn("GPU delegate failed, falling back to CPU:", err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      });
    }
  }

  // Runs detection on one video frame. `source` is a canvas or video
  // element. Returns [{ landmarks: [{x,y,z} x21], label: "Left"|"Right" }].
  process(source) {
    if (!this.landmarker) return [];

    // detectForVideo requires strictly increasing timestamps.
    let ts = Math.round(performance.now());
    if (ts <= this._lastTimestampMs) ts = this._lastTimestampMs + 1;
    this._lastTimestampMs = ts;

    const result = this.landmarker.detectForVideo(source, ts);

    const hands = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      hands.push({
        landmarks: result.landmarks[i],
        label: result.handedness[i][0].categoryName,
      });
    }
    return hands;
  }

  // Overlays the hand skeleton on a 2D canvas context for on-screen feedback.
  draw(ctx, width, height, handsData) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#33ff99";
    ctx.fillStyle = "#ff8a3d";

    for (const hand of handsData) {
      const pts = hand.landmarks.map((p) => [p.x * width, p.y * height]);

      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(pts[a][0], pts[a][1]);
        ctx.lineTo(pts[b][0], pts[b][1]);
      }
      ctx.stroke();

      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}