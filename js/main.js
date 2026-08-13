// main.js
//
// Wires together the webcam feed, hand tracker, gesture controller, and 3D
// viewer, and drives two loops:
//   - renderLoop(): always running (even before the camera starts), so the
//     viewport is never blank and mouse control always works.
//   - loop(): only runs while the camera is active; this is the gesture
//     detection pipeline.
// This is the browser equivalent of the original main.py.

import { HandTracker } from "./handTracker.js";
import { GestureController, GestureAction } from "./gestureController.js";
import { CadViewer } from "./cadViewer.js";

const video = document.getElementById("webcam");
const captureCanvas = document.getElementById("captureCanvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
const viewerCanvas = document.getElementById("viewerCanvas");

const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const fpsEl = document.getElementById("fps");
const handsEl = document.getElementById("handsDetected");
const pinchDistEl = document.getElementById("pinchDist");
const wireframeStateEl = document.getElementById("wireframeState");
const measureResultEl = document.getElementById("measureResult");
const benchmarkStatusEl = document.getElementById("benchmarkStatus");

const startBtn = document.getElementById("startBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const wireframeBtn = document.getElementById("wireframeBtn");
const measureBtn = document.getElementById("measureBtn");
const mirrorCheckbox = document.getElementById("mirrorCheckbox");
const modelInput = document.getElementById("modelInput");
const downloadLogBtn = document.getElementById("downloadLogBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const benchGestureBtn = document.getElementById("benchGestureBtn");
const benchMouseBtn = document.getElementById("benchMouseBtn");
const benchDownloadBtn = document.getElementById("benchDownloadBtn");
const viewButtons = document.querySelectorAll(".view-btn");

const pinchSlider = document.getElementById("pinchSlider");
const panSlider = document.getElementById("panSlider");
const rotateSlider = document.getElementById("rotateSlider");
const zoomSlider = document.getElementById("zoomSlider");
const pinchValue = document.getElementById("pinchValue");
const panValue = document.getElementById("panValue");
const rotateValue = document.getElementById("rotateValue");
const zoomValue = document.getElementById("zoomValue");

const tracker = new HandTracker();
const controller = new GestureController();
const viewer = new CadViewer(viewerCanvas);

let running = false;
let lastFrameTime = performance.now();
let fps = 0;
const sessionLog = [];

// --- Mode-display smoothing ------------------------------------------------
// gesture.state is recomputed fresh every single frame straight from the
// current landmarks, with no memory of previous frames. That's correct for
// driving actions (the controller already latches those so they don't
// re-fire), but showing it directly in the "Mode" pill means any one noisy
// frame — a hand mid-transition between poses, a momentary tracking glitch —
// flashes across the screen just like a real, held pose would. In practice
// that showed up as things like a held THUMBS DOWN being immediately
// followed by a flicker through IDLE/PAN/LEFT/etc. that the person was never
// actually doing, making it hard to tell whether a gesture had really
// registered.
//
// This buffers the last MODE_SMOOTHING_WINDOW raw states and displays
// whichever one is most common across that window, so a single stray frame
// can't flip the display on its own — it takes a run of consecutive frames
// agreeing before the shown mode actually changes. At ~30fps this costs
// roughly 150-200ms of extra display latency, which is unnoticeable for a
// status readout but enough to smooth out frame-to-frame jitter. This only
// affects what's displayed — pan/rotate/zoom and one-shot actions
// (fist/thumbs/snap-view) still come straight from the controller every
// frame, so movement stays responsive and actions still fire on their real
// rising edge.
const MODE_SMOOTHING_WINDOW = 6;
let modeHistory = [];

function smoothedMode(rawState, handsVisible) {
  if (!handsVisible) {
    // No hands means IDLE should show up immediately, not lag behind
    // whatever pose was held right before the hand left frame.
    modeHistory = [];
    return rawState;
  }

  modeHistory.push(rawState);
  if (modeHistory.length > MODE_SMOOTHING_WINDOW) modeHistory.shift();

  const counts = new Map();
  for (const s of modeHistory) counts.set(s, (counts.get(s) ?? 0) + 1);

  let best = rawState;
  let bestCount = 0;
  for (const [s, c] of counts) {
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

let wireframeOn = false;
let measureMode = false;
let calibrationCollector = null; // { samples: [] } while a calibration phase is collecting
let statusRevertTimer = null;

// --- Status pill helper ------------------------------------------------

// Shows a transient message in the status pill, then reverts to "Running"
// (only if the camera is still active) so one-shot gesture feedback
// doesn't permanently overwrite the running state.
function flashStatus(message, revertMs = 1500) {
  statusEl.textContent = message;
  if (statusRevertTimer) clearTimeout(statusRevertTimer);
  statusRevertTimer = setTimeout(() => {
    if (running) statusEl.textContent = "Running";
  }, revertMs);
}

// --- Settings panel -------------------------------------------------------

function applySliderSettings() {
  controller.pinchThreshold = Number(pinchSlider.value);
  controller.panGain = Number(panSlider.value);
  controller.rotateGain = Number(rotateSlider.value);
  controller.zoomGain = Number(zoomSlider.value);

  pinchValue.textContent = controller.pinchThreshold.toFixed(2);
  panValue.textContent = controller.panGain.toFixed(1);
  rotateValue.textContent = controller.rotateGain.toFixed(0);
  zoomValue.textContent = controller.zoomGain.toFixed(1);
}

[pinchSlider, panSlider, rotateSlider, zoomSlider].forEach((el) =>
  el.addEventListener("input", applySliderSettings)
);
applySliderSettings();

// --- Wireframe toggle (shared by the manual button and the thumbs-up/down gesture) ---

function applyWireframe(enabled) {
  wireframeOn = enabled;
  viewer.setWireframe(enabled);
  wireframeStateEl.textContent = enabled ? "on" : "off";
  wireframeBtn.classList.toggle("active", enabled);
}

wireframeBtn.addEventListener("click", () => applyWireframe(!wireframeOn));

// --- View presets (buttons + keyboard 1-7 + hand gestures) ------------------
// Views can be triggered three ways: clicking a button, pressing keys 1-7,
// or holding one of the 7 "counting" hand poses (see gestureController.js —
// VIEW_COUNTS and handleGestureAction() below). Keys/buttons stay in place
// as a reliable fallback, especially for "1"/Front, whose counting pose
// (thumb up, rest curled) is identical to the THUMBS_UP gesture and is
// always won by that gesture instead — see the caveat comment at the top of
// gestureController.js.

const VIEW_KEY_ORDER = ["front", "back", "left", "right", "top", "bottom", "iso"];
const VIEW_LABELS = {
  front: "Front",
  back: "Back",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  iso: "Iso",
};

viewButtons.forEach((btn) => {
  btn.addEventListener("click", () => viewer.snapToView(btn.dataset.view));
});

window.addEventListener("keydown", (e) => {
  // Ignore keystrokes while typing into an input/select/textarea.
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  const index = Number(e.key) - 1; // keys "1".."7" -> indices 0..6
  if (!Number.isInteger(index) || index < 0 || index >= VIEW_KEY_ORDER.length) return;

  const view = VIEW_KEY_ORDER[index];
  viewer.snapToView(view);
  flashStatus(`Key ${e.key} — snapped to ${VIEW_LABELS[view]} view.`);
});

// --- Mouse control (same viewer.pan/rotate/zoom the gestures use, so a
// benchmark comparing mouse vs. gesture is comparing input methods only,
// not two different camera implementations) --------------------------------

let dragging = false;
let dragButton = 0;
let lastMouseX = 0;
let lastMouseY = 0;

viewerCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

viewerCanvas.addEventListener("mousedown", (e) => {
  if (measureMode) return; // clicks in measure mode pick points, not drag
  dragging = true;
  dragButton = e.button;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

window.addEventListener("mouseup", () => {
  dragging = false;
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  if (dragButton === 2) {
    viewer.pan(dx * 0.8, -dy * 0.8);
  } else {
    viewer.rotate(dx * 1.5, dy * 1.5);
  }
});

viewerCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    viewer.zoom(-e.deltaY * 0.05);
  },
  { passive: false }
);

// --- Measurement tool --------------------------------------------------

measureBtn.addEventListener("click", () => {
  measureMode = !measureMode;
  measureBtn.classList.toggle("active", measureMode);
  viewer.clearMeasurement();
  measureResultEl.textContent = "– units";
  if (measureMode) {
    flashStatus("Measure mode: click two points on the model.", 3000);
  }
});

viewerCanvas.addEventListener("click", (e) => {
  if (!measureMode) return;
  const rect = viewerCanvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  const result = viewer.addMeasurePoint(ndcX, ndcY);

  if (result.status === "miss") {
    flashStatus("Measure: that click missed the model — try again.", 1500);
  } else if (result.status === "first") {
    flashStatus("First point placed — click a second point.", 2500);
  } else if (result.status === "complete") {
    measureResultEl.textContent = `${result.distance.toFixed(3)} units`;
    flashStatus(`Measured ${result.distance.toFixed(3)} model units.`, 2000);
  }
});

// --- Pinch auto-calibration --------------------------------------------

function collectPhase(message, durationMs) {
  return new Promise((resolve) => {
    flashStatus(message, durationMs + 500);
    calibrationCollector = { samples: [] };
    setTimeout(() => {
      const { samples } = calibrationCollector ?? { samples: [] };
      calibrationCollector = null;
      resolve(samples);
    }, durationMs);
  });
}

async function runPinchCalibration() {
  if (!running) {
    flashStatus("Start the camera first, then calibrate.", 2000);
    return;
  }
  calibrateBtn.disabled = true;

  const openSamples = await collectPhase(
    "Calibrating — hold your hand open (relaxed), fingers apart...",
    2200
  );
  const closedSamples = await collectPhase(
    "Now pinch thumb + index fully together and hold...",
    2200
  );

  calibrateBtn.disabled = false;

  if (openSamples.length < 5 || closedSamples.length < 5) {
    flashStatus("Calibration failed — keep one hand clearly visible throughout. Try again.", 3000);
    return;
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const openAvg = avg(openSamples);
  const closedAvg = avg(closedSamples);

  if (openAvg <= closedAvg * 1.2) {
    flashStatus(
      "Calibration inconclusive — open vs. pinched distance was too similar. Try a clearer pinch.",
      3500
    );
    return;
  }

  // Land the threshold 40% of the way from "closed" to "open" — reachable
  // without being so loose it fires on a relaxed hand.
  const raw = closedAvg + (openAvg - closedAvg) * 0.4;
  const clamped = Math.min(Math.max(raw, Number(pinchSlider.min)), Number(pinchSlider.max));

  pinchSlider.value = clamped.toFixed(2);
  applySliderSettings();
  flashStatus(`Calibrated — pinch threshold set to ${clamped.toFixed(2)}.`, 3000);
}

calibrateBtn.addEventListener("click", runPinchCalibration);

// --- Benchmark mode: gesture vs. mouse ----------------------------------

let benchmark = null; // { mode, target: {theta, phi}, startTime, matched }
const benchmarkLog = [];
const MATCH_TOLERANCE = 0.15; // radians, for both theta and phi
const MIN_TASK_DISTANCE = MATCH_TOLERANCE * 3; // how far the target must be from the baseline

function randomTarget() {
  return {
    theta: (Math.random() * 2 - 1) * Math.PI,
    phi: Math.PI / 2 + (Math.random() * 2 - 1) * 0.8, // stays clear of the poles
  };
}

function angularDelta(a, b) {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

// Picks a target that's actually far enough from the baseline to be a real
// task. Without this, a target could land close to (or, rarely, exactly
// at) wherever the camera already happens to be, letting a trial "match"
// almost instantly through no skill at all — which would silently poison
// the elapsed-time comparison between gesture and mouse.
function randomTargetAwayFrom(baseline, maxAttempts = 20) {
  let target = randomTarget();
  for (let i = 0; i < maxAttempts; i++) {
    const farEnough =
      angularDelta(target.theta, baseline.theta) >= MIN_TASK_DISTANCE ||
      Math.abs(target.phi - baseline.phi) >= MIN_TASK_DISTANCE;
    if (farEnough) break;
    target = randomTarget();
  }
  return target;
}

function startBenchmark(mode) {
  if (mode === "gesture" && !running) {
    benchmarkStatusEl.textContent = "Start the camera first to benchmark gestures.";
    return;
  }

  // Every trial starts from the same known orientation, not wherever the
  // camera happened to be left after the previous trial (or after regular
  // gesture/mouse use). Without this, elapsed time measures "distance to
  // an arbitrary leftover starting point" as much as it measures input
  // speed, which defeats the point of comparing gesture vs. mouse.
  viewer.resetView();
  const baseline = { theta: viewer.spherical.theta, phi: viewer.spherical.phi };

  benchmark = {
    mode,
    target: randomTargetAwayFrom(baseline),
    startTime: performance.now(),
    matched: false,
  };
  benchmarkStatusEl.textContent = `Match the target view using ${mode} — go!`;
}

benchGestureBtn.addEventListener("click", () => startBenchmark("gesture"));
benchMouseBtn.addEventListener("click", () => startBenchmark("mouse"));

benchDownloadBtn.addEventListener("click", () => {
  if (benchmarkLog.length === 0) {
    benchmarkStatusEl.textContent = "No benchmark results yet — run at least one trial first.";
    return;
  }
  const header = "timestamp,mode,elapsed_ms\n";
  const rows = benchmarkLog.map((row) => row.join(",")).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `benchmark_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

// --- Session log download ------------------------------------------------

downloadLogBtn.addEventListener("click", () => {
  if (sessionLog.length === 0) {
    statusEl.textContent = "No session data yet — start the camera first.";
    return;
  }
  const header =
    "timestamp_ms,fps,hands_detected,state,pan_dx,pan_dy,rotate_dx,rotate_dy,zoom,pinch_dist,view,action\n";
  const rows = sessionLog.map((row) => row.join(",")).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `session_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

// --- Model loading ---------------------------------------------------------

resetViewBtn.addEventListener("click", () => viewer.resetView());

modelInput.addEventListener("change", async () => {
  const file = modelInput.files[0];
  if (!file) return;
  try {
    statusEl.textContent = `Loading ${file.name}...`;
    await viewer.loadFromFile(file);
    applyWireframe(wireframeOn); // re-apply current wireframe state to the new model
    statusEl.textContent = `Loaded ${file.name}`;
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    modelInput.value = "";
  }
});

// --- Persistent render loop: always running, camera or not -----------------
// (Previously the viewport only rendered inside the gesture loop, which only
// ran once the camera started — meaning the 3D view was blank on page load
// and mouse control had nothing to draw to. This loop fixes that and also
// drives the benchmark's target-match check.)

function renderLoop() {
  viewer.render();

  if (benchmark && !benchmark.matched) {
    const dTheta = angularDelta(viewer.spherical.theta, benchmark.target.theta);
    const dPhi = Math.abs(viewer.spherical.phi - benchmark.target.phi);
    const elapsedS = (performance.now() - benchmark.startTime) / 1000;

    if (dTheta < MATCH_TOLERANCE && dPhi < MATCH_TOLERANCE) {
      benchmark.matched = true;
      const elapsedMs = performance.now() - benchmark.startTime;
      benchmarkLog.push([Date.now(), benchmark.mode, elapsedMs.toFixed(0)]);
      benchmarkStatusEl.textContent = `Matched in ${(elapsedMs / 1000).toFixed(2)}s (${benchmark.mode}).`;
    } else {
      benchmarkStatusEl.textContent = `${benchmark.mode}: ${elapsedS.toFixed(1)}s elapsed — keep going...`;
    }
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// --- Gesture action handling ---------------------------------------------
// fist = reset, thumbs up/down = wireframe, and the 7 counting poses = snap
// to a view (front/back/left/right/top/bottom/iso) — same views as keys 1-7.

function handleGestureAction(gesture) {
  const { action, view } = gesture;
  if (!action) return;

  if (action === GestureAction.RESET_VIEW) {
    viewer.resetView();
    flashStatus("Fist detected — view reset.");
  } else if (action === GestureAction.WIREFRAME_ON) {
    applyWireframe(true);
    flashStatus("Thumbs up — wireframe on.");
  } else if (action === GestureAction.WIREFRAME_OFF) {
    applyWireframe(false);
    flashStatus("Thumbs down — wireframe off.");
  } else if (action === GestureAction.SNAP_VIEW && view) {
    viewer.snapToView(view);
    flashStatus(`Gesture — snapped to ${VIEW_LABELS[view] ?? view} view.`);
  }
}

// --- Camera + gesture detection loop ---------------------------------------

startBtn.addEventListener("click", startCamera);

async function startCamera() {
  startBtn.disabled = true;
  statusEl.textContent = "Requesting camera access...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 720 },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;

    statusEl.textContent = "Loading hand-tracking model (first run downloads ~10 MB)...";
    await tracker.init();

    statusEl.textContent = "Running";
    running = true;
    lastFrameTime = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    statusEl.textContent = `Could not start: ${err.message}`;
    startBtn.disabled = false;
  }
}

// Draws the current webcam frame onto the capture canvas, mirrored if
// requested. Detection and the on-screen skeleton both use this canvas, so
// what you see always matches what the model is reacting to.
function drawCurrentFrame() {
  const width = captureCanvas.width;
  const height = captureCanvas.height;
  captureCtx.save();
  if (mirrorCheckbox.checked) {
    captureCtx.translate(width, 0);
    captureCtx.scale(-1, 1);
  }
  captureCtx.drawImage(video, 0, 0, width, height);
  captureCtx.restore();
}

function loop() {
  if (!running) return;

  drawCurrentFrame();
  const handsData = tracker.process(captureCanvas);
  const gesture = controller.update(handsData);

  if (calibrationCollector && gesture.pinchDistance !== null) {
    calibrationCollector.samples.push(gesture.pinchDistance);
  }

  if (gesture.pan) viewer.pan(gesture.pan.dx, gesture.pan.dy);
  if (gesture.rotate) viewer.rotate(gesture.rotate.dx, gesture.rotate.dy);
  if (gesture.zoom !== null) viewer.zoom(gesture.zoom);
  handleGestureAction(gesture);

  // Rendering itself now happens in the always-on renderLoop(); this loop
  // only needs to draw the hand-skeleton overlay on the camera feed.
  tracker.draw(captureCtx, captureCanvas.width, captureCanvas.height, handsData);

  const now = performance.now();
  fps = 0.9 * fps + 0.1 * (1000 / Math.max(now - lastFrameTime, 1));
  lastFrameTime = now;

  modeEl.textContent = smoothedMode(gesture.state, handsData.length > 0);
  fpsEl.textContent = fps.toFixed(1);
  handsEl.textContent = String(handsData.length);
  pinchDistEl.textContent =
    gesture.pinchDistance !== null
      ? `${gesture.pinchDistance.toFixed(2)} / ${controller.pinchThreshold.toFixed(2)}`
      : "–";

  sessionLog.push([
    now.toFixed(0),
    fps.toFixed(2),
    handsData.length,
    gesture.state,
    gesture.pan?.dx.toFixed(4) ?? "",
    gesture.pan?.dy.toFixed(4) ?? "",
    gesture.rotate?.dx.toFixed(4) ?? "",
    gesture.rotate?.dy.toFixed(4) ?? "",
    gesture.zoom?.toFixed(4) ?? "",
    gesture.pinchDistance?.toFixed(4) ?? "",
    gesture.view ?? "",
    gesture.action ?? "",
  ]);

  requestAnimationFrame(loop);
}