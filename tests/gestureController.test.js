// tests/gestureController.test.js
//
// Run with: npm test  (or: node --test tests/)
//
// Uses Node's built-in test runner and assert module, so there is nothing
// extra to install. gestureController.js has no DOM or MediaPipe
// dependency, which is what makes it testable on its own like this.

import test from "node:test";
import assert from "node:assert/strict";
import {
  EMA,
  dist,
  handScale,
  fingersExtended,
  isOpenPalm,
  isPinch,
  GestureController,
  GestureState,
} from "../js/gestureController.js";

// --- Synthetic hand poses ---------------------------------------------------
// Rough, plausible 21-point layouts. Only the relationships the algorithm
// actually reads (tip vs. pip, tip-to-tip distance, wrist-to-mcp distance)
// need to be realistic — exact anatomy doesn't matter for these tests.

function openHandLandmarks() {
  const lm = new Array(21);
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // wrist
  lm[1] = { x: 0.65, y: 0.8, z: 0 };
  lm[2] = { x: 0.62, y: 0.75, z: 0 }; // thumb MCP
  lm[3] = { x: 0.58, y: 0.65, z: 0 };
  lm[4] = { x: 0.5, y: 0.55, z: 0 }; // thumb TIP (x < mcp.x)
  lm[5] = { x: 0.45, y: 0.6, z: 0 }; // index MCP
  lm[6] = { x: 0.45, y: 0.5, z: 0 }; // index PIP
  lm[7] = { x: 0.45, y: 0.4, z: 0 };
  lm[8] = { x: 0.45, y: 0.3, z: 0 }; // index TIP (y < pip.y => extended)
  lm[9] = { x: 0.5, y: 0.55, z: 0 }; // middle MCP
  lm[10] = { x: 0.5, y: 0.45, z: 0 };
  lm[11] = { x: 0.5, y: 0.35, z: 0 };
  lm[12] = { x: 0.5, y: 0.25, z: 0 }; // middle TIP
  lm[13] = { x: 0.55, y: 0.6, z: 0 };
  lm[14] = { x: 0.55, y: 0.5, z: 0 };
  lm[15] = { x: 0.55, y: 0.4, z: 0 };
  lm[16] = { x: 0.55, y: 0.3, z: 0 }; // ring TIP
  lm[17] = { x: 0.6, y: 0.65, z: 0 };
  lm[18] = { x: 0.6, y: 0.55, z: 0 };
  lm[19] = { x: 0.6, y: 0.45, z: 0 };
  lm[20] = { x: 0.6, y: 0.35, z: 0 }; // pinky TIP
  return lm;
}

function fistLandmarks() {
  const lm = openHandLandmarks();
  // Curl each fingertip back down past its pip, and tuck the thumb in.
  lm[8] = { x: 0.45, y: 0.58, z: 0 };
  lm[12] = { x: 0.5, y: 0.53, z: 0 };
  lm[16] = { x: 0.55, y: 0.58, z: 0 };
  lm[20] = { x: 0.6, y: 0.63, z: 0 };
  lm[2] = { x: 0.62, y: 0.75, z: 0 };
  lm[4] = { x: 0.65, y: 0.72, z: 0 }; // thumb TIP (x > mcp.x => not extended)
  return lm;
}

function pinchLandmarks() {
  const lm = openHandLandmarks();
  // Bring thumb and index tips together; everything else can stay put.
  lm[4] = { x: 0.44, y: 0.42, z: 0 };
  lm[8] = { x: 0.45, y: 0.4, z: 0 };
  return lm;
}

// --- EMA ---------------------------------------------------------------

test("EMA returns the first value unchanged", () => {
  const ema = new EMA(0.4);
  assert.equal(ema.update(10), 10);
});

test("EMA blends toward new values without jumping straight to them", () => {
  const ema = new EMA(0.5);
  ema.update(0);
  const next = ema.update(10);
  assert.ok(next > 0 && next < 10);
});

test("EMA.reset() clears smoothing history", () => {
  const ema = new EMA(0.4);
  ema.update(10);
  ema.reset();
  assert.equal(ema.value, null);
  assert.equal(ema.update(3), 3);
});

// --- Geometry helpers ----------------------------------------------------

test("dist() computes straight-line distance and ignores z", () => {
  assert.equal(dist({ x: 0, y: 0, z: 99 }, { x: 3, y: 4, z: -99 }), 5);
});

test("handScale() never returns zero, even for coincident points", () => {
  const lm = openHandLandmarks();
  lm[0] = { x: 0.5, y: 0.5, z: 0 };
  lm[9] = { x: 0.5, y: 0.5, z: 0 };
  assert.ok(handScale(lm) > 0);
});

// --- Finger / palm / pinch classification ---------------------------------

test("fingersExtended() reads an open hand as extended", () => {
  const extended = fingersExtended(openHandLandmarks(), "Right");
  assert.deepEqual(extended, [true, true, true, true, true]);
});

test("fingersExtended() reads a fist as curled", () => {
  const extended = fingersExtended(fistLandmarks(), "Right");
  assert.deepEqual(extended, [false, false, false, false, false]);
});

test("isOpenPalm() is true for an open hand, false for a fist", () => {
  assert.equal(isOpenPalm(openHandLandmarks(), "Right"), true);
  assert.equal(isOpenPalm(fistLandmarks(), "Right"), false);
});

test("isPinch() detects thumb and index close together", () => {
  const { pinching } = isPinch(pinchLandmarks(), 0.4);
  assert.equal(pinching, true);
});

test("isPinch() does not fire on an open, spread-out hand", () => {
  const { pinching } = isPinch(openHandLandmarks(), 0.4);
  assert.equal(pinching, false);
});

// --- GestureController state machine ---------------------------------------

test("no hands visible is IDLE", () => {
  const controller = new GestureController();
  const result = controller.update([]);
  assert.equal(result.state, GestureState.IDLE);
  assert.equal(result.pan, null);
  assert.equal(result.rotate, null);
  assert.equal(result.zoom, null);
});

test("one open hand is ROTATE, with no delta on the first frame", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: openHandLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.ROTATE);
  assert.equal(result.rotate, null); // needs a previous frame to compute a delta
});

test("ROTATE produces a delta once the palm has moved between frames", () => {
  const controller = new GestureController({ rotateGain: 100 });
  const first = openHandLandmarks();
  controller.update([{ landmarks: first, label: "Right" }]);

  const second = openHandLandmarks();
  second[9] = { x: first[9].x + 0.05, y: first[9].y, z: 0 }; // palm moved right
  const result = controller.update([{ landmarks: second, label: "Right" }]);

  assert.equal(result.state, GestureState.ROTATE);
  assert.ok(result.rotate.dx > 0);
});

test("a pinch is PAN, not ROTATE", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: pinchLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.PAN);
});

test("a fist (neither pinch nor open palm) is IDLE", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: fistLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.IDLE);
});

test("two hands is ZOOM, with no delta on the first frame", () => {
  const controller = new GestureController();
  const hands = [
    { landmarks: openHandLandmarks(), label: "Left" },
    { landmarks: openHandLandmarks(), label: "Right" },
  ];
  const result = controller.update(hands);
  assert.equal(result.state, GestureState.ZOOM);
  assert.equal(result.zoom, null);
});

test("ZOOM is positive when hands move apart", () => {
  const controller = new GestureController({ zoomGain: 100 });
  const near = [
    { landmarks: openHandLandmarks(), label: "Left" },
    { landmarks: openHandLandmarks(), label: "Right" },
  ];
  near[0].landmarks[9] = { x: 0.3, y: 0.5, z: 0 };
  near[1].landmarks[9] = { x: 0.5, y: 0.5, z: 0 };
  controller.update(near);

  const far = [
    { landmarks: openHandLandmarks(), label: "Left" },
    { landmarks: openHandLandmarks(), label: "Right" },
  ];
  far[0].landmarks[9] = { x: 0.1, y: 0.5, z: 0 };
  far[1].landmarks[9] = { x: 0.9, y: 0.5, z: 0 };
  const result = controller.update(far);

  assert.equal(result.state, GestureState.ZOOM);
  assert.ok(result.zoom > 0);
});

test("switching gestures resets the previous gesture's memory", () => {
  const controller = new GestureController();

  // Start panning and move the pinch point.
  const pinchA = pinchLandmarks();
  controller.update([{ landmarks: pinchA, label: "Right" }]);
  const pinchB = pinchLandmarks();
  pinchB[4] = { x: pinchA[4].x + 0.05, y: pinchA[4].y, z: 0 };
  pinchB[8] = { x: pinchA[8].x + 0.05, y: pinchA[8].y, z: 0 };
  const panResult = controller.update([{ landmarks: pinchB, label: "Right" }]);
  assert.ok(panResult.pan);

  // Drop to no hands, then start a fresh pinch — it should not carry over
  // the old position and produce a phantom jump.
  controller.update([]);
  const fresh = controller.update([{ landmarks: pinchLandmarks(), label: "Right" }]);
  assert.equal(fresh.pan, null);
});
