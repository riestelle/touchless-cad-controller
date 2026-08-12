# Touchless CAD Controller

Control a 3D model with your hands — no mouse, no keyboard, no extra
sensors. Point a webcam at your hand, pinch/rotate/zoom in the air, and the
model responds in real time, entirely in the browser.

**🔗 Live demo:** https://touchless-cad-controller.vercel.app/


---

## What is this?

Engineering students working in labs — soldering, machining, handling
resin or clay — constantly have to stop, wash their hands, and touch a
mouse and keyboard just to rotate a 3D model on screen. This project
removes that step: a standard laptop or USB webcam tracks your hand in
mid-air and translates gestures directly into pan, rotate, and zoom
commands on a 3D viewport, so you can inspect a model without ever
touching — or dirtying — your equipment.

It runs the same hand-tracking model (MediaPipe's HandLandmarker, 21
landmarks per hand) that a Python/OpenCV version would use, but compiled to
WebAssembly and running client-side in the browser instead. That means:
zero installs, no Python version conflicts, works on any recent Chrome,
Edge, or Firefox — including lab machines you don't control.

## Features

**Core navigation**
- ✋ **Pinch + drag** (one hand) — pan the model
- 🖐️ **Open palm, move** (one hand) — rotate the model
- 🤲 **Two hands**, apart/together — zoom in/out
- Live pinch-distance readout so you can see exactly how close a pinch is
  to registering, instead of guessing

**Evaluation tooling**
- **Session logger** — per-frame FPS, gesture state, and movement deltas,
  exportable as CSV
- **Gesture-vs-mouse benchmark mode** — times how long it takes to match a
  randomized target camera orientation under each input method, exported
  as CSV, for a direct head-to-head comparison

**Model support**
- Load your own `.stl`, `.obj`, or `.ply` file, or use the built-in
  placeholder part — no CLI flags, just a file picker

## Tech stack

| Piece | What it does |
|---|---|
| [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) | Hand landmark detection, running in-browser via WASM |
| [Three.js](https://threejs.org/) | 3D scene, camera, and model rendering |
| Vanilla JS (no framework, no bundler) | Everything else |
| Node's built-in test runner | Unit tests for the gesture-classification algorithm |

No build step. The whole thing is static HTML/CSS/JS, which is also why it
deploys to Vercel with zero configuration.

## How it works, briefly

1. **`handTracker.js`** wraps MediaPipe's HandLandmarker — webcam frame in,
   21 hand landmarks + Left/Right label out.
2. **`gestureController.js`** is the actual algorithm: pure functions that
   take landmarks and classify them into pinch / open-palm / fist / thumb
   poses, with EMA smoothing so hand tremor doesn't translate into jittery
   model movement. It has no DOM or MediaPipe dependency, which is what
   makes it unit-testable on its own.
3. **`cadViewer.js`** is the Three.js side — an orbiting camera driven by
   spherical coordinates, plus model loading and the measurement raycaster.
4. **`main.js`** wires the three together and runs the render/detection
   loops.

## Deployment notes

This is a fully static project (`server.js` is only a zero-dependency dev
convenience for local testing — Vercel doesn't use it). If your Vercel
deployment behaves unexpectedly, check that no unrelated `vercel.json` or
config from a different project is sitting in this repo, since a static
deploy needs none.

Camera access requires `https://` or `localhost` — Vercel's deployment URL
already satisfies that, so camera permission prompts should work
out of the box on the live demo.

## Project objectives

Built around three objectives for a touchless-interaction study:

1. **Touchless webcam input** — no extra sensors, just `getUserMedia()` +
   in-browser hand tracking.
2. **Gesture → CAD command algorithm** — the classification and smoothing
   logic in `gestureController.js`, unit-tested against synthetic hand
   poses.
3. **Measuring speed, smoothness, and efficiency** — the session logger and
   benchmark mode above give you real per-frame and per-task data to
   compare gesture input against a mouse, rather than relying on
   impressions.
