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
  isFist,
  isThumbPose,
  viewPose,
  GestureController,
  GestureState,
  GestureAction,
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

function thumbsUpLandmarks() {
  const lm = fistLandmarks(); // 4 main fingers curled
  lm[2] = { x: 0.62, y: 0.75, z: 0 }; // thumb MCP
  lm[4] = { x: 0.55, y: 0.2, z: 0 }; // thumb TIP: x < mcp.x (extended), well above wrist
  return lm;
}

function thumbsDownLandmarks() {
  const lm = fistLandmarks();
  lm[2] = { x: 0.62, y: 0.75, z: 0 };
  lm[4] = { x: 0.55, y: 1.3, z: 0 }; // thumb TIP: extended, well below wrist
  return lm;
}

// A relaxed, real-world fist: fingers curled the same as fistLandmarks(),
// but the thumb rests up along the side of the curled fingers instead of
// tucked flush against the palm — close to the wrist/palm center, not
// clearly pulled away from it. This should still read as FIST, not
// THUMBS_UP (see the isFist()/isThumbPose() comments in gestureController.js).
function restingThumbFistLandmarks() {
  const lm = fistLandmarks();
  lm[2] = { x: 0.62, y: 0.75, z: 0 }; // thumb MCP
  lm[4] = { x: 0.6, y: 0.62, z: 0 }; // thumb TIP: a little up, but close to palm center (0.5, 0.55)
  return lm;
}

// A thumb pointing mostly sideways (left/right), only slightly higher than
// its own knuckle. This should not register as THUMBS_UP just because it's
// a bit above the wrist — it must be close to vertical to count.
function thumbsSidewaysLandmarks() {
  const lm = fistLandmarks();
  lm[2] = { x: 0.62, y: 0.75, z: 0 }; // thumb MCP
  lm[4] = { x: 0.95, y: 0.7, z: 0 }; // thumb TIP: far out sideways, barely higher than MCP
  return lm;
}

// Landmarks for a "counting" view-snap pose: starts from a fist and
// extends exactly the requested fingers. `pattern` is
// { thumb, index, middle, ring, pinky } booleans. When the thumb is part
// of the count it's extended straight up (same shape isThumbPose() would
// also accept), and when it's not part of the count it stays tucked in,
// same as fistLandmarks().
function countPoseLandmarks({ thumb = false, index = false, middle = false, ring = false, pinky = false } = {}) {
  const lm = fistLandmarks();
  if (thumb) {
    lm[2] = { x: 0.62, y: 0.75, z: 0 }; // thumb MCP
    lm[4] = { x: 0.55, y: 0.2, z: 0 }; // thumb TIP: extended, straight up
  }
  if (index) lm[8] = { x: 0.45, y: 0.3, z: 0 };
  if (middle) lm[12] = { x: 0.5, y: 0.25, z: 0 };
  if (ring) lm[16] = { x: 0.55, y: 0.3, z: 0 };
  if (pinky) lm[20] = { x: 0.6, y: 0.35, z: 0 };
  return lm;
}

function pinchLandmarks() {
  const lm = openHandLandmarks();
  // Bring thumb and index tips together; everything else can stay put.
  lm[4] = { x: 0.44, y: 0.42, z: 0 };
  lm[8] = { x: 0.45, y: 0.4, z: 0 };
  return lm;
}

// A more "real webcam" pinch attempt: starts from a curled hand (like a
// fist) and brings the thumb and index TIPS close together, but the index
// tip still ends up below its pip (reads as "curled" by the tip-vs-pip
// test) and the thumb tip stays on the "not extended" side of the x-check.
// All 4 main fingers therefore read as curled, same as a real fist — this
// is exactly the case that used to satisfy isFist() before isPinch() ever
// ran, so it misfired as FIST/reset-view instead of PAN.
function realisticPinchLandmarks() {
  const lm = fistLandmarks();
  lm[4] = { x: 0.63, y: 0.56, z: 0 }; // thumb tip: still x > mcp.x (not "extended"), but near index tip
  lm[8] = { x: 0.6, y: 0.58, z: 0 }; // index tip: still below its pip (curled), but near thumb tip
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

// --- Fist / thumb-pose classification ---------------------------------------

test("isFist() is true for a curled hand regardless of thumb", () => {
  assert.equal(isFist(fistLandmarks(), "Right"), true);
  assert.equal(isFist(openHandLandmarks(), "Right"), false);
});

test("isThumbPose() reads up/down only when the 4 main fingers are curled and thumb is clearly extended", () => {
  assert.equal(isThumbPose(openHandLandmarks(), "Right"), null); // fingers not curled
  assert.equal(isThumbPose(fistLandmarks(), "Right"), null); // thumb not extended either
  assert.equal(isThumbPose(thumbsUpLandmarks(), "Right"), "up");
  assert.equal(isThumbPose(thumbsDownLandmarks(), "Right"), "down");
});

test("isThumbPose() ignores hand label / mirroring — up/down comes from the thumb's own direction", () => {
  // Same shapes as "Right", but labeled "Left". The old x-position-vs-label
  // heuristic would have gotten this backwards; the distance/angle-based
  // version doesn't care about the label at all.
  assert.equal(isThumbPose(thumbsUpLandmarks(), "Left"), "up");
  assert.equal(isThumbPose(thumbsDownLandmarks(), "Left"), "down");
});

test("isThumbPose() returns null for a relaxed fist whose thumb rests near the palm (not pulled away)", () => {
  // Regression test: a normal, relaxed fist often has the thumb resting up
  // alongside the curled fingers rather than tucked flush against the
  // palm. That used to be close enough to satisfy the old "thumb above
  // wrist" check and get misread as THUMBS_UP, which is exactly why a real
  // fist reliably failed to register as FIST.
  assert.equal(isThumbPose(restingThumbFistLandmarks(), "Right"), null);
});

test("isThumbPose() returns null for a thumb pointing mostly sideways, even if slightly higher than its knuckle", () => {
  // Regression test: a thumb held out to the left/right used to be able to
  // register as "up" just from being marginally above the wrist. It must
  // now be close to vertical to count at all.
  assert.equal(isThumbPose(thumbsSidewaysLandmarks(), "Right"), null);
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

test("a fist is its own state, not a generic IDLE (see the FIST tests below for the reset action)", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: fistLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.FIST);
  assert.equal(result.pan, null);
  assert.equal(result.rotate, null);
  assert.equal(result.zoom, null);
});

test("a relaxed real-world fist (thumb resting near the palm, not tucked flush) still registers as FIST", () => {
  // Regression test for the "fist is never recognized" bug: this is the
  // pose a real hand naturally makes (see restingThumbFistLandmarks()),
  // and it must resolve to FIST/RESET_VIEW rather than THUMBS_UP.
  const controller = new GestureController();
  const result = controller.update([{ landmarks: restingThumbFistLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.FIST);
  assert.equal(result.action, GestureAction.RESET_VIEW);
});

test("a realistic pinch (fingers curled like a fist, thumb+index tips close) is PAN, not FIST", () => {
  // Regression test for the misclassification bug: even when all 4 main
  // fingers read as curled (which is also true of a fist), a close
  // thumb-to-index distance must win and register as PAN.
  const controller = new GestureController();
  const result = controller.update([{ landmarks: realisticPinchLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.PAN);
  assert.notEqual(result.state, GestureState.FIST);
  assert.equal(result.action, null); // PAN is continuous, not a one-shot action like FIST
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

test("a not-quite-closed pinch is IDLE, not misread as ROTATE", () => {
  // Thumb has moved noticeably toward the index finger (this is what a
  // real, slightly-imprecise pinch attempt looks like on a webcam) but
  // doesn't cross the pinch threshold. The other 4 fingers still read as
  // "extended," so without a buffer this used to fall through to
  // isOpenPalm() and get classified as ROTATE.
  const lm = openHandLandmarks();
  lm[4] = { x: 0.5, y: 0.5, z: 0 }; // thumb tip moved toward index, not touching

  const controller = new GestureController({ pinchThreshold: 0.4 });
  const result = controller.update([{ landmarks: lm, label: "Right" }]);

  assert.equal(result.state, GestureState.IDLE);
  assert.equal(result.rotate, null);
});

test("a fist fires RESET_VIEW once, then latches until released", () => {
  const controller = new GestureController();

  const first = controller.update([{ landmarks: fistLandmarks(), label: "Right" }]);
  assert.equal(first.state, GestureState.FIST);
  assert.equal(first.action, GestureAction.RESET_VIEW);

  // Holding the fist should not keep re-firing the action every frame.
  const held = controller.update([{ landmarks: fistLandmarks(), label: "Right" }]);
  assert.equal(held.state, GestureState.FIST);
  assert.equal(held.action, null);

  // Releasing and re-forming the fist should fire it again.
  controller.update([]);
  const again = controller.update([{ landmarks: fistLandmarks(), label: "Right" }]);
  assert.equal(again.action, GestureAction.RESET_VIEW);
});

test("thumbs up fires WIREFRAME_ON once; thumbs down fires WIREFRAME_OFF once", () => {
  const controller = new GestureController();

  const up = controller.update([{ landmarks: thumbsUpLandmarks(), label: "Right" }]);
  assert.equal(up.state, GestureState.THUMBS_UP);
  assert.equal(up.action, GestureAction.WIREFRAME_ON);

  const heldUp = controller.update([{ landmarks: thumbsUpLandmarks(), label: "Right" }]);
  assert.equal(heldUp.action, null); // latched

  const down = controller.update([{ landmarks: thumbsDownLandmarks(), label: "Right" }]);
  assert.equal(down.state, GestureState.THUMBS_DOWN);
  assert.equal(down.action, GestureAction.WIREFRAME_OFF); // switching pose re-fires
});

// --- View-snap counting gestures ---------------------------------------

test("viewPose() recognizes counts 2-7 (thumb-side then pinky-side)", () => {
  assert.equal(viewPose(countPoseLandmarks({ thumb: true, index: true }), "Right"), "back"); // 2
  assert.equal(viewPose(countPoseLandmarks({ thumb: true, index: true, middle: true }), "Right"), "left"); // 3
  assert.equal(
    viewPose(countPoseLandmarks({ thumb: true, index: true, middle: true, ring: true }), "Right"),
    "right" // 4
  );
  assert.equal(viewPose(countPoseLandmarks({ pinky: true }), "Right"), "top"); // 5
  assert.equal(viewPose(countPoseLandmarks({ pinky: true, ring: true }), "Right"), "bottom"); // 6
  assert.equal(viewPose(countPoseLandmarks({ pinky: true, ring: true, middle: true }), "Right"), "iso"); // 7
});

test("viewPose() reads count 1 (thumb only) as 'front' at the pure finger-pattern level", () => {
  // viewPose() only looks at which fingers are up — it has no opinion about
  // the thumb-pose collision. GestureController resolves that collision
  // (see the next test); this just confirms the pattern match itself.
  assert.equal(viewPose(countPoseLandmarks({ thumb: true }), "Right"), "front");
});

test("viewPose() returns null for a fist (0 fingers) and an open hand (5 fingers)", () => {
  assert.equal(viewPose(fistLandmarks(), "Right"), null);
  assert.equal(viewPose(openHandLandmarks(), "Right"), null);
});

test("GestureController: count 1 (thumb only) resolves to THUMBS_UP, not FRONT — same physical pose", () => {
  // This is the documented collision: "thumb up, rest curled" is exactly
  // the THUMBS_UP gesture, so that gesture wins and Front stays reachable
  // only via the "1" key/button, not this exact hand shape.
  const controller = new GestureController();
  const result = controller.update([{ landmarks: countPoseLandmarks({ thumb: true }), label: "Right" }]);
  assert.equal(result.state, GestureState.THUMBS_UP);
  assert.equal(result.action, GestureAction.WIREFRAME_ON);
});

test("GestureController fires SNAP_VIEW once for an unambiguous count, then latches until released", () => {
  const controller = new GestureController();
  const lm = countPoseLandmarks({ thumb: true, index: true }); // "2" -> back

  const first = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(first.state, GestureState.BACK);
  assert.equal(first.view, "back");
  assert.equal(first.action, GestureAction.SNAP_VIEW);

  const held = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(held.action, null); // latched, doesn't re-fire every frame

  const iso = controller.update([
    { landmarks: countPoseLandmarks({ pinky: true, ring: true, middle: true }), label: "Right" }, // "7"
  ]);
  assert.equal(iso.state, GestureState.ISO);
  assert.equal(iso.view, "iso");
  assert.equal(iso.action, GestureAction.SNAP_VIEW); // switching poses re-fires
});

test("GestureController: count 4 (4 of 5 fingers up) is SNAP_VIEW, not misread as ROTATE", () => {
  // Regression guard: "4" (thumb+index+middle+ring) satisfies isOpenPalm()'s
  // ">= 4 extended" threshold too, so counting-view must win before the
  // open-palm fallback ever runs.
  const controller = new GestureController();
  const lm = countPoseLandmarks({ thumb: true, index: true, middle: true, ring: true });
  const result = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(result.state, GestureState.RIGHT);
  assert.equal(result.rotate, null);
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