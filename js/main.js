// main.js
//
// Wires together the webcam feed, hand tracker, gesture controller, and 3D
// viewer, and drives the render loop. This is the browser equivalent of the
// original main.py.

import { HandTracker } from "./handTracker.js";
import { GestureController } from "./gestureController.js";
import { CadViewer } from "./cadViewer.js";

const video = document.getElementById("webcam");
const captureCanvas = document.getElementById("captureCanvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
const viewerCanvas = document.getElementById("viewerCanvas");

const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const fpsEl = document.getElementById("fps");
const handsEl = document.getElementById("handsDetected");

const startBtn = document.getElementById("startBtn");
const resetViewBtn = document.getElementById("resetViewBtn");
const mirrorCheckbox = document.getElementById("mirrorCheckbox");
const modelInput = document.getElementById("modelInput");
const downloadLogBtn = document.getElementById("downloadLogBtn");

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

// --- Buttons ---------------------------------------------------------------

resetViewBtn.addEventListener("click", () => viewer.resetView());

modelInput.addEventListener("change", async () => {
  const file = modelInput.files[0];
  if (!file) return;
  try {
    statusEl.textContent = `Loading ${file.name}...`;
    await viewer.loadFromFile(file);
    statusEl.textContent = `Loaded ${file.name}`;
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    modelInput.value = "";
  }
});

downloadLogBtn.addEventListener("click", () => {
  if (sessionLog.length === 0) {
    statusEl.textContent = "No session data yet — start the camera first.";
    return;
  }
  const header = "timestamp_ms,fps,hands_detected,state,pan_dx,pan_dy,rotate_dx,rotate_dy,zoom\n";
  const rows = sessionLog.map((row) => row.join(",")).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `session_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

startBtn.addEventListener("click", startCamera);

// --- Camera + detection loop ------------------------------------------------

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

  if (gesture.pan) viewer.pan(gesture.pan.dx, gesture.pan.dy);
  if (gesture.rotate) viewer.rotate(gesture.rotate.dx, gesture.rotate.dy);
  if (gesture.zoom !== null) viewer.zoom(gesture.zoom);

  viewer.render();
  tracker.draw(captureCtx, captureCanvas.width, captureCanvas.height, handsData);

  const now = performance.now();
  fps = 0.9 * fps + 0.1 * (1000 / Math.max(now - lastFrameTime, 1));
  lastFrameTime = now;

  modeEl.textContent = gesture.state;
  fpsEl.textContent = fps.toFixed(1);
  handsEl.textContent = String(handsData.length);

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
  ]);

  requestAnimationFrame(loop);
}
