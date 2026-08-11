# Software-Engineering-2


# Touchless 3D CAD Model Navigation via Webcam Gesture Tracking

Control a 3D model with hand gestures picked up by a normal laptop/USB webcam —
no mouse, no keyboard, no extra sensors. Built with **MediaPipe** (hand tracking)
and **Open3D** (3D viewer).

## What's in this folder

| File | Purpose |
|---|---|
| `hand_tracker.py` | Wraps MediaPipe's HandLandmarker; turns a webcam frame into 21 hand landmarks + Left/Right label |
| `gesture_controller.py` | Classifies pinch / open-palm / two-hand gestures and smooths them (EMA filter) into pan/rotate/zoom deltas |
| `main.py` | Captures webcam, runs the two modules above, drives the Open3D viewer |
| `requirements.txt` | Python dependencies |

## Gestures

| Gesture | Effect |
|---|---|
| One hand, **pinch** thumb + index finger, then drag | **Pan** the model |
| One hand, **open palm**, move it around | **Rotate** the model |
| **Two hands**, move them apart / together | **Zoom** in / out |
| No hand / any other pose | Idle — nothing moves |

---

## Step-by-step setup

### 1. Install Python
You need **Python 3.9–3.12** (MediaPipe doesn't yet ship wheels for 3.13+).
Check your version:
```bash
python3 --version
```
If you need to install/upgrade Python, get it from [python.org/downloads](https://www.python.org/downloads/).

### 2. Get the project files
Put `hand_tracker.py`, `gesture_controller.py`, `main.py`, and `requirements.txt`
in one folder, e.g. `touchless_cad_controller/`, and open a terminal there.

### 3. Create a virtual environment (recommended)
This keeps the project's packages separate from the rest of your system.

**Windows:**
```bash
python -m venv venv
venv\Scripts\activate
```

**macOS / Linux:**
```bash
python3 -m venv venv
source venv/bin/activate
```
You'll know it worked because your terminal prompt now starts with `(venv)`.

### 4. Install the dependencies
```bash
pip install -r requirements.txt
```
This installs:
- `opencv-python` — webcam capture + on-screen debug overlay
- `mediapipe` — the hand-tracking model
- `open3d` — the 3D viewer and camera controls
- `numpy` — math helpers

### 5. Run it
```bash
python main.py
```
The **first run downloads a small hand-tracking model file** (~10 MB, one-time,
requires internet). After that it works fully offline.

Two windows will open:
1. **"Webcam - Hand Tracking"** — your camera feed with the hand skeleton drawn on it, plus the current mode (PAN/ROTATE/ZOOM/IDLE) and FPS.
2. **"Touchless CAD Viewer"** — the 3D model you're controlling. By default this is a simple bracket-shaped placeholder part so the demo works with zero setup.

Press **`q`** in the webcam window to quit.

### 6. (Optional) Use your own CAD model
If you have an `.obj`, `.stl`, or `.ply` file (export these from most CAD tools,
e.g. SolidWorks → "Save As" → STL):
```bash
python main.py --model path/to/your_part.stl
```

### 7. (Optional) Log data for your evaluation objective
Your third objective is measuring speed/smoothness/efficiency — this flag
writes a CSV with a row per frame (timestamp, FPS, gesture state, and the
raw pan/rotate/zoom values) that you can graph in Excel/Python afterward:
```bash
python main.py --log session1.csv
```

### 8. (Optional) Different webcam or no mirroring
```bash
python main.py --camera 1        # use the second camera device
python main.py --no-mirror       # disable the left/right flip
```

---

## Troubleshooting

**"could not open webcam"**
Another app (Zoom, Teams, browser tab) may be holding the camera — close it
and retry. Also check your OS camera privacy settings allow Python/Terminal
to use the camera.

**Model download fails on first run**
You need an internet connection the first time only. If your network blocks
`storage.googleapis.com`, download the model manually from
`https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`
and save it as `hand_landmarker.task` in the same folder as `main.py`.

**Gestures feel jumpy or misclassified**
- Make sure your hand is well-lit and the whole hand is inside the camera frame.
- The pinch threshold assumes a fairly deliberate pinch; if it triggers too
  easily (or not easily enough), adjust `pinch_threshold` in
  `GestureController(...)` inside `main.py` (try values between 0.3–0.5).
- To make rotation/pan feel more or less sensitive, adjust `rotate_gain` /
  `pan_gain` / `zoom_gain` the same way.

**Open3D window doesn't appear / crashes on launch**
Open3D needs a real display (it won't work over a plain SSH session without
X forwarding, or on a headless server). Run it on your local machine directly.

**Low FPS**
- Close other apps using the camera/GPU.
- Lower `detection_confidence`/`tracking_confidence` slightly in
  `HandTracker(...)` for faster (if slightly less accurate) tracking.
- Reduce webcam resolution: add `cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)` and
  `cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)` right after `cv2.VideoCapture(...)`
  in `main.py`.

---

## How it maps to your project's objectives

- **Objective 1 (touchless webcam input):** `hand_tracker.py` does this — no
  extra sensors, just `cv2.VideoCapture` + MediaPipe.
- **Objective 2 (gesture → CAD command algorithm):** `gesture_controller.py`
  is that algorithm — it converts pinch distance, palm-open detection, and
  two-hand distance into pan/rotate/zoom commands, and `main.py` feeds those
  into Open3D's camera controls (`view_control.translate/rotate/scale`),
  which is the standard way to navigate a 3D scene like a CAD viewport.
- **Objective 3 (measuring speed/smoothness/efficiency):** the on-screen FPS
  counter plus the `--log` CSV option give you raw data (FPS over time,
  gesture-state transitions, per-frame movement deltas) to analyze for your
  write-up — e.g. plotting FPS stability, or timing how long it takes users
  to complete a rotate-then-zoom task versus a mouse.

## Ideas if you want to extend this further
- Add a "fist" gesture to reset the camera to its default view.
- Add a third hand-pose (e.g., thumbs-up) to toggle wireframe vs. solid rendering.
- Run a small user study: have classmates complete the same navigation task
  with a mouse vs. with gestures, and compare completion time and error rate
  for your results section.