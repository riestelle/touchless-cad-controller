# Touchless 3D CAD Model Navigation via Webcam Gesture Tracking

Control a 3D model with hand gestures picked up by a normal laptop/USB webcam —
no mouse, no keyboard, no extra sensors, and **no Python install.**

This runs entirely in your web browser using **MediaPipe's Tasks Vision**
(hand tracking, compiled to WebAssembly) and **Three.js** (the 3D viewer).
Open one HTML file through a local server and it works.

## Why this version is different from a Python/OpenCV version

The original plan for this project used Python, OpenCV, MediaPipe's Python
package, and Open3D. That stack has one recurring problem for a shared lab
setting: MediaPipe's Python wheels only support specific Python versions,
so whoever runs the project first has to install a matching Python version
side-by-side with whatever they already have, then fight `pip` until the
versions line up. That's a bad experience for a demo you want to just work
on a lab machine.

Moving the same algorithm to the browser removes that problem:

| | Python + OpenCV + Open3D | Browser (this version) |
|---|---|---|
| Install | Match a specific Python version, then `pip install` four packages | A browser (already installed) + optionally Node.js for one local server script |
| First run | Can fail on Python-version mismatches | Works on any recent Chrome, Edge, or Firefox |
| Startup time | ~2–4s to import OpenCV/MediaPipe/Open3D | Page load + one-time ~10 MB model download |
| Cross-platform | Windows/macOS/Linux, but native-dependency issues are common | Anywhere a modern browser runs, including Chromebooks |
| Runs the same detection model? | Yes (MediaPipe HandLandmarker) | Yes — same model file, same 21-point landmarks, run in-browser via WebAssembly instead of natively |

The gesture-recognition math (pinch detection, open-palm detection,
two-hand distance, EMA smoothing) is the same algorithm from the Python
version, translated line-for-line into JavaScript. Nothing about *how* the
gestures are recognized changed — only *where* the code runs.

**Trade-off to know about:** the Python version, once installed, worked
fully offline. This version fetches the hand-tracking model and two small
libraries (MediaPipe's WASM runtime, Three.js) from a CDN. Your browser
caches them after the first successful run, so subsequent runs on the same
machine are typically fast and mostly-offline — but if you need a
guaranteed zero-internet demo, test it once on the target machine/network
beforehand.

## What's in this folder

```
touchless_cad_controller/
├── index.html                      Page layout: camera panel, 3D viewport, settings
├── style.css                       Visual styling
├── server.js                       Zero-dependency local file server
├── package.json                    Project metadata + npm scripts (no dependencies to install)
├── js/
│   ├── handTracker.js              Wraps MediaPipe HandLandmarker (webcam -> 21 landmarks + Left/Right)
│   ├── gestureController.js        Classifies pinch / open-palm / two-hand gestures, smooths them (EMA)
│   ├── cadViewer.js                Three.js scene, camera, and pan/rotate/zoom + model loading (.stl/.obj/.ply)
│   └── main.js                     Wires the above together and runs the frame loop
└── tests/
    └── gestureController.test.js   Unit tests for the gesture-classification logic
```

That's more than the original 3 files on purpose: `gestureController.js` (the
algorithm) is now separated cleanly from `handTracker.js` (camera input) and
`cadViewer.js` (3D rendering), each has one job, and there's a real test file
covering the algorithm's logic instead of only manual testing.

## Gestures

| Gesture | Effect |
|---|---|
| One hand, **pinch** thumb + index finger, then drag | **Pan** the model |
| One hand, **open palm**, move it around | **Rotate** the model |
| **Two hands**, move them apart / together | **Zoom** in / out |
| No hand / any other pose | Idle — nothing moves |

---

## Step-by-step setup

### 1. Get the project files

Put this whole `touchless_cad_controller/` folder somewhere on your computer.

### 2. Serve the folder locally

Browsers block camera access and the `import` statements this project uses
when you just double-click `index.html` (a `file://` page). You need to
serve the folder over `http://` instead. Pick whichever option below you
already have available — you only need one.

**Option A — Node.js (recommended, zero extra installs)**
If you have [Node.js](https://nodejs.org) (any version 18 or newer — unlike
MediaPipe's Python wheels, this is not picky about the exact version):
```bash
node server.js
```
or, equivalently:
```bash
npm start
```
Then open **http://localhost:8000** in your browser.

**Option B — VS Code "Live Server" extension**
If you use VS Code, install the free **Live Server** extension, right-click
`index.html`, and choose **"Open with Live Server."** No terminal needed.

**Option C — Any other static server you already have**
Anything that serves static files works: `npx serve`, `php -S
localhost:8000`, an IDE's built-in server, etc. Just point it at this
folder and open the URL it gives you.

### 3. Open it and allow camera access

Go to the local URL from step 2, click **Start camera**, and allow camera
access when the browser prompts you. The **first run downloads the
hand-tracking model** (~10 MB, one-time, requires internet). After that,
your browser caches it.

You'll see:
- **Camera feed** (left) — your webcam with the hand skeleton drawn on it,
  plus live Mode / FPS / Hands-detected readouts.
- **3D viewport** (middle) — the model you're controlling. By default this
  is a simple bracket-shaped placeholder part so the demo works with zero
  setup.
- **Settings** (right) — sliders to tune sensitivity, plus the gesture
  reference.

### 4. (Optional) Use your own CAD model

Export an `.stl`, `.obj`, or `.ply` file from your CAD tool (e.g.
SolidWorks → "Save As" → STL), then click **Load model** in the 3D
viewport toolbar and pick the file. No command-line flag needed — it's a
file picker in the UI.

### 5. (Optional) Log data for your evaluation objective

Click **Download log** at any point after starting the camera. It saves a
CSV (timestamp, FPS, hands detected, gesture state, and the raw
pan/rotate/zoom values for every frame so far) that you can graph in
Excel/Python afterward — the same fields the original `--log` flag wrote.

### 6. (Optional) Tune sensitivity without editing code

The original Python version required editing constructor arguments in
`main.py` to change how sensitive gestures felt. This version exposes the
same four numbers — pinch threshold, pan speed, rotate speed, zoom speed —
as sliders in the Settings panel, live, while the camera is running.

### 7. (Optional) Run the algorithm's tests

```bash
npm test
```
This runs `tests/gestureController.test.js` against the pinch/palm/two-hand
classification logic using synthetic hand poses — useful for objective 2
(the gesture → CAD command algorithm) if you need to show automated
verification in your write-up.

---

## Troubleshooting

**"Could not start: Permission denied" / no camera prompt appears**
Another app (Zoom, Teams, a browser tab) may be holding the camera — close
it and retry. Also check your OS camera privacy settings allow your
browser to use the camera. Camera access also requires either
`http://localhost` (fine) or `https://` — it will not work if you open the
page directly as a `file://` path.

**Model download fails / page hangs on "Loading hand-tracking model..."**
You need an internet connection the first time only. If your network
blocks `storage.googleapis.com` or `cdn.jsdelivr.net`, this setup won't be
able to fetch the model or libraries — check with your network admin, or
test on a different network once and then reuse the same browser profile
(browsers cache these files after a successful load).

**Gestures feel jumpy or misclassified**
- Make sure your hand is well-lit and the whole hand is inside the camera frame.
- Open the **Settings** panel and adjust **Pinch threshold** if pinch
  triggers too easily or not easily enough.
- Adjust **Pan/Rotate/Zoom speed** the same way if movement feels too fast
  or too slow.

**3D viewport is black / nothing renders**
Your browser needs WebGL support (all modern browsers have this by
default). Check `chrome://gpu` (or your browser's equivalent) if you
suspect hardware acceleration is disabled.

**Hand tracking feels slow / low FPS**
- Close other apps using the camera or GPU.
- Try a different browser — Chrome and Edge tend to have the fastest WASM
  and WebGL performance.
- The app already tries the GPU delegate first and falls back to CPU
  automatically; a CPU fallback will be noticeably slower on older machines.

**"Unsupported file type" when loading a model**
Only `.stl`, `.obj`, and `.ply` are supported, matching the original
Python version's `--model` flag.

---

## How it maps to your project's objectives

- **Objective 1 (touchless webcam input):** `handTracker.js` does this — no
  extra sensors, just `getUserMedia()` + MediaPipe's HandLandmarker running
  in-browser via WebAssembly.
- **Objective 2 (gesture → CAD command algorithm):** `gestureController.js`
  is that algorithm — it converts pinch distance, palm-open detection, and
  two-hand distance into pan/rotate/zoom commands (unit-tested in
  `tests/gestureController.test.js`), and `cadViewer.js` feeds those into a
  Three.js orbit camera, which is the browser equivalent of Open3D's
  `view_control.translate/rotate/scale`.
- **Objective 3 (measuring speed/smoothness/efficiency):** the on-screen
  FPS readout plus the **Download log** button give you the same
  per-frame data (FPS over time, gesture-state transitions, movement
  deltas) to analyze for your write-up — e.g. plotting FPS stability, or
  timing a rotate-then-zoom task with gestures vs. a mouse.

## Browser requirements

A recent version of Chrome, Edge, or Firefox with a webcam and WebGL
support. Safari works for basic use but MediaPipe's GPU delegate support on
Safari is less consistent — the app automatically falls back to the CPU
delegate if GPU initialization fails, just slower.

## Ideas if you want to extend this further

- Add a "fist" gesture to reset the camera view (there's already a **Reset
  view** button — this would make it gesture-driven instead).
- Add a third hand pose (e.g., thumbs-up) to toggle wireframe vs. solid
  rendering in `cadViewer.js`.
- Run a small user study: have classmates complete the same navigation
  task with a mouse vs. with gestures, using **Download log** to compare
  completion time and error rate for your results section.
