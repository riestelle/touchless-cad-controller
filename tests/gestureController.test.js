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
  isThumbExtended,
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
  lm[3] = { x: 0.4, y: 0.55, z: 0 };
  // Thumb TIP: a natural open/spread hand (the ROTATE pose) holds the thumb
  // out and away from the palm, not tucked in — clearly extended per the
  // distance-from-palm test in viewPose(), so this fixture can never be
  // mistaken for a "Right" snap-view count (which is thumb-tucked in).
  // Still satisfies x < mcp.x (the separate x-position check other tests
  // rely on).
  lm[4] = { x: 0.2, y: 0.35, z: 0 };
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

// An "OK sign" pinch: thumb and index tips brought together to touch (like
// pinchLandmarks()), but built on top of countPoseLandmarks({pinky, ring,
// middle}) so the other 3 fingers are raised too — i.e. the real-world
// shape in the "make an OK sign" screenshot. At the pure "which fingers are
// up" level this is indistinguishable from the "7"/ISO counting pose (see
// VIEW_COUNTS.iso): index down, middle/ring/pinky up, thumb tucked. Only
// the thumb-index touching/reaching distinguishes it as a pinch.
function okSignPinchLandmarks() {
  const lm = countPoseLandmarks({ pinky: true, ring: true, middle: true }); // "7" finger pattern
  lm[4] = { x: 0.44, y: 0.42, z: 0 }; // thumb tip reaches in to meet the index tip
  lm[8] = { x: 0.45, y: 0.4, z: 0 }; // index tip reaches toward the thumb, not left resting curled
  return lm;
}

// A hand rotated so the fingers point down and toward the camera (fingers
// folded, back of the folded fingers facing the lens) rather than the
// usual "fingers point up" framing every other fixture uses. Physically
// this is still a curled fist with the thumb pointing down (THUMBS_DOWN),
// but a raw tip.y < pip.y screen-space check gets confused by the
// rotation: folding a finger toward a wrist that is now ABOVE it (instead
// of below, as in fistLandmarks()) can leave the folded tip with a
// SMALLER y (higher up on screen) than its own pip, which used to misread
// as "extended". Distance-from-wrist does not have this problem.
function rotatedThumbsDownLandmarks() {
  const lm = new Array(21);
  lm[0] = { x: 0.5, y: 0.15, z: 0 }; // wrist near the TOP of frame (hand flipped)
  // Index: mcp/pip extend downward from the wrist, tip curls back up
  // toward the wrist (smaller y than the pip), but stays closer to the
  // wrist than the pip does, i.e. genuinely curled.
  lm[5] = { x: 0.4, y: 0.35, z: 0 };
  lm[6] = { x: 0.4, y: 0.55, z: 0 };
  lm[7] = { x: 0.4, y: 0.45, z: 0 };
  lm[8] = { x: 0.4, y: 0.4, z: 0 }; // folded tip: y < pip.y, but closer to wrist than pip
  lm[9] = { x: 0.45, y: 0.35, z: 0 };
  lm[10] = { x: 0.45, y: 0.58, z: 0 };
  lm[11] = { x: 0.45, y: 0.48, z: 0 };
  lm[12] = { x: 0.45, y: 0.42, z: 0 };
  lm[13] = { x: 0.5, y: 0.35, z: 0 };
  lm[14] = { x: 0.5, y: 0.56, z: 0 };
  lm[15] = { x: 0.5, y: 0.46, z: 0 };
  lm[16] = { x: 0.5, y: 0.4, z: 0 };
  lm[17] = { x: 0.55, y: 0.35, z: 0 };
  lm[18] = { x: 0.55, y: 0.53, z: 0 };
  lm[19] = { x: 0.55, y: 0.44, z: 0 };
  lm[20] = { x: 0.55, y: 0.38, z: 0 };
  // Thumb: pulled clearly away from the palm and pointing further down
  // (larger y) than the frame's wrist-below-fingers norm — same "down"
  // direction rule isThumbPose() already uses (dy > 0 => down).
  lm[1] = { x: 0.35, y: 0.25, z: 0 };
  lm[2] = { x: 0.32, y: 0.3, z: 0 }; // thumb MCP
  lm[3] = { x: 0.35, y: 0.55, z: 0 };
  lm[4] = { x: 0.4, y: 0.85, z: 0 }; // thumb TIP: far below its MCP => "down"
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

test("fingersExtended() reads curled fingers as curled even when the hand is rotated so folded tips land above their pips on screen", () => {
  // Regression test: a raw tip.y < pip.y screen-space check flips when the
  // hand is rotated (e.g. wrist above the fingers instead of below), so a
  // genuinely folded finger can misread as "extended" purely from camera
  // framing. Distance-from-wrist must not have this problem.
  const extended = fingersExtended(rotatedThumbsDownLandmarks(), "Right");
  assert.deepEqual(extended.slice(0, 4), [false, false, false, false]);
});

test("isThumbPose() recognizes THUMBS_DOWN even when the folded fingers face the camera at an angle that would fool a y-only curl check", () => {
  assert.equal(isThumbPose(rotatedThumbsDownLandmarks(), "Right"), "down");
});

test("GestureController recognizes THUMBS_DOWN for the rotated/folded-fingers-toward-camera hand shape", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: rotatedThumbsDownLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.THUMBS_DOWN);
  assert.equal(result.action, GestureAction.WIREFRAME_OFF);
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

test("a not-quite-closed pinch with the thumb still out is IDLE, not misread as ROTATE", () => {
  // Thumb has moved noticeably toward the index finger (this is what a
  // real, slightly-imprecise pinch attempt looks like on a webcam) but
  // doesn't cross the pinch threshold, and stays far enough from the palm
  // that it doesn't read as "tucked" either. The other 4 fingers still
  // read as "extended," so without a buffer this used to fall through to
  // isOpenPalm() and get classified as ROTATE.
  //
  // NOTE: if the thumb tucks in close to the palm during a sloppy pinch
  // attempt (distance-from-palm below THUMB_EXTENSION_THRESHOLD), the
  // hand shape becomes indistinguishable from the "Right" snap-view count
  // (index+middle+ring+pinky, thumb tucked) and SNAP_VIEW wins instead —
  // that's an accepted trade-off of dropping the thumb from that pose,
  // see the big comment at the top of the file.
  const lm = openHandLandmarks();
  lm[4] = { x: 0.65, y: 0.32, z: 0 }; // thumb tip drifted toward index, not touching, not tucked

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
    viewPose(countPoseLandmarks({ index: true, middle: true, ring: true, pinky: true }), "Right"),
    "right" // 4
  );
  assert.equal(viewPose(countPoseLandmarks({ pinky: true }), "Right"), "top"); // 5
  assert.equal(viewPose(countPoseLandmarks({ pinky: true, ring: true }), "Right"), "bottom"); // 6
  assert.equal(viewPose(countPoseLandmarks({ pinky: true, ring: true, middle: true }), "Right"), "iso"); // 7
});

test("viewPose() reads count 1 (index only) as 'front'", () => {
  // Front deliberately excludes the thumb (see the big comment at the top
  // of the file) so it can never be confused with THUMBS_UP.
  assert.equal(viewPose(countPoseLandmarks({ index: true }), "Right"), "front");
});

test("viewPose() returns null for a fist (0 fingers) and an open hand (5 fingers)", () => {
  assert.equal(viewPose(fistLandmarks(), "Right"), null);
  assert.equal(viewPose(openHandLandmarks(), "Right"), null);
});

test("GestureController: thumb-only pose still resolves to THUMBS_UP, not FRONT", () => {
  // Front no longer shares a pose with THUMBS_UP (it's index-only now), but
  // a plain thumb-only hand shape should still resolve to THUMBS_UP rather
  // than falling through to some other state.
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
  // Regression guard: "4" (index+middle+ring+pinky) satisfies isOpenPalm()'s
  // ">= 4 extended" threshold too, so counting-view must win before the
  // open-palm fallback ever runs.
  const controller = new GestureController();
  const lm = countPoseLandmarks({ index: true, middle: true, ring: true, pinky: true });
  const result = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(result.state, GestureState.RIGHT);
  assert.equal(result.rotate, null);
});

// --- ROTATE vs. RIGHT (4) regression -------------------------------------
//
// Bug: an ordinary, relaxed open-palm hand — thumb unfolded and resting out
// to the side, but not flung dramatically far from the palm — used to get
// misread as the "4"/RIGHT counting pose instead of ROTATE. isOpenPalm()
// and viewPose() used to classify "is the thumb extended" two different
// ways: isOpenPalm() (via fingersExtended()'s old left/right x-check) called
// it extended fairly easily, while viewPose() required the thumb to sit at
// least 0.75x hand-scale from the palm center — a bar a normal, unexaggerated
// open hand often doesn't clear. Since view-snap poses are checked before
// the open-palm fallback, RIGHT won almost every time. See
// isThumbExtended()'s comment in gestureController.js for the full story.
function naturalOpenHandLandmarks() {
  const lm = new Array(21);
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // wrist
  lm[1] = { x: 0.6, y: 0.8, z: 0 };
  lm[2] = { x: 0.58, y: 0.72, z: 0 }; // thumb MCP
  lm[3] = { x: 0.48, y: 0.62, z: 0 }; // thumb IP
  // Thumb TIP: straight and unfolded, resting moderately out to the side —
  // NOT flung out dramatically like openHandLandmarks()'s thumb. This is
  // what a typical relaxed open-palm hand actually looks like.
  lm[4] = { x: 0.35, y: 0.55, z: 0 };
  lm[5] = { x: 0.45, y: 0.6, z: 0 };
  lm[6] = { x: 0.45, y: 0.5, z: 0 };
  lm[7] = { x: 0.45, y: 0.4, z: 0 };
  lm[8] = { x: 0.45, y: 0.3, z: 0 };
  lm[9] = { x: 0.5, y: 0.55, z: 0 };
  lm[10] = { x: 0.5, y: 0.45, z: 0 };
  lm[11] = { x: 0.5, y: 0.35, z: 0 };
  lm[12] = { x: 0.5, y: 0.25, z: 0 };
  lm[13] = { x: 0.55, y: 0.6, z: 0 };
  lm[14] = { x: 0.55, y: 0.5, z: 0 };
  lm[15] = { x: 0.55, y: 0.4, z: 0 };
  lm[16] = { x: 0.55, y: 0.3, z: 0 };
  lm[17] = { x: 0.6, y: 0.65, z: 0 };
  lm[18] = { x: 0.6, y: 0.55, z: 0 };
  lm[19] = { x: 0.6, y: 0.45, z: 0 };
  lm[20] = { x: 0.6, y: 0.35, z: 0 };
  return lm;
}

test("isThumbExtended() reads a moderately-out, unfolded thumb as extended, not just a dramatically splayed one", () => {
  assert.equal(isThumbExtended(naturalOpenHandLandmarks()), true);
});

test("REGRESSION: a natural, unexaggerated open palm is ROTATE, not misread as RIGHT (4)", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: naturalOpenHandLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.ROTATE);
  assert.notEqual(result.state, GestureState.RIGHT);
  assert.equal(result.view, null);
});

test("REGRESSION: viewPose() returns null (not 'right') for the natural open-palm hand shape", () => {
  assert.equal(viewPose(naturalOpenHandLandmarks(), "Right"), null);
});

test("a genuinely tucked thumb still resolves to RIGHT (4), not ROTATE", () => {
  // The flip side of the regression above: RIGHT must still fire when the
  // thumb is actually folded back toward its own base, not just resting
  // somewhere short of a dramatic sideways fling.
  const controller = new GestureController();
  const lm = countPoseLandmarks({ index: true, middle: true, ring: true, pinky: true }); // thumb stays tucked
  const result = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(result.state, GestureState.RIGHT);
  assert.equal(result.rotate, null);
});

test("GestureController: pinky-side counts (5-7) are not swallowed by a coincidental pinch reading", () => {
  // Regression test: with the thumb tucked in (not part of the 5-7 counts)
  // and the index also curled (not one of the extended fingers), the raw
  // thumb-to-index distance can coincidentally land under the pinch
  // threshold purely from hand shape — but the exact view-pose pattern
  // match must win before pinch ever gets a chance to misclassify it.
  const controller = new GestureController();
  const top = controller.update([{ landmarks: countPoseLandmarks({ pinky: true }), label: "Right" }]); // "5"
  assert.equal(top.state, GestureState.TOP);
  assert.notEqual(top.state, GestureState.PAN);

  const iso = controller.update([
    { landmarks: countPoseLandmarks({ pinky: true, ring: true, middle: true }), label: "Right" }, // "7"
  ]);
  assert.equal(iso.state, GestureState.ISO);
  assert.notEqual(iso.state, GestureState.PAN);
});

test("isPinch() fires for an OK-sign pinch even though its finger pattern matches the ISO (7) counting pose", () => {
  // The OK sign (thumb+index touching, middle/ring/pinky raised) has the
  // exact same "which fingers are up" pattern as VIEW_COUNTS.iso. isPinch()
  // must still say yes here, because the index is genuinely reaching for
  // the thumb (see MIN_INDEX_REACH_FOR_PINCH) rather than resting curled.
  const { pinching } = isPinch(okSignPinchLandmarks(), 0.4);
  assert.equal(pinching, true);
});

test("GestureController: an OK sign resolves to PAN (pinch), not ISO, despite the identical finger pattern", () => {
  const controller = new GestureController();
  const result = controller.update([{ landmarks: okSignPinchLandmarks(), label: "Right" }]);
  assert.equal(result.state, GestureState.PAN);
  assert.notEqual(result.state, GestureState.ISO);
  assert.equal(result.action, null); // PAN isn't a one-shot action gesture
});

test("isPinch() does not fire when the thumb happens to be close to a curled, resting index tip", () => {
  // Regression test: a real fist (knuckles toward the camera) can put the
  // thumb tip and the folded index tip close together in the 2D image by
  // coincidence, even though the index finger never reached for anything.
  // isPinch() must require the index to actually be reaching away from its
  // own knuckle, not just happen to be near the thumb.
  const lm = fistLandmarks();
  lm[4] = { x: 0.46, y: 0.57, z: 0 }; // thumb tip moved right next to the curled index tip
  const { pinching } = isPinch(lm, 0.4);
  assert.equal(pinching, false);
});

test("GestureController: a fist with the thumb coincidentally near the curled index still resolves to FIST", () => {
  const lm = fistLandmarks();
  lm[4] = { x: 0.46, y: 0.57, z: 0 }; // thumb tip moved right next to the curled index tip
  const controller = new GestureController();
  const result = controller.update([{ landmarks: lm, label: "Right" }]);
  assert.equal(result.state, GestureState.FIST);
  assert.equal(result.action, GestureAction.RESET_VIEW);
});

// --- panGain scale regression ---------------------------------------------
//
// Bug: the default panGain (2.5) was ~100x smaller than the default
// rotateGain (250), even though cadViewer.js's PAN_UNIT/ROTATE_UNIT are
// only 2x apart - so a pinch-drag moved the model roughly 50x less than an
// open-palm rotate for the same hand movement, and the "Pan speed" slider's
// range (0.5-6) couldn't make up the difference even maxed out.

test("REGRESSION: default panGain is on the same order of magnitude as rotateGain, not ~100x smaller", () => {
  const controller = new GestureController();
  // cadViewer.js applies PAN_UNIT=0.01 vs ROTATE_UNIT=0.005 (2x apart), so
  // panGain should be roughly half of rotateGain, not orders of magnitude
  // below it.
  assert.ok(
    controller.panGain >= controller.rotateGain / 4,
    `panGain (${controller.panGain}) is far too small relative to rotateGain (${controller.rotateGain}) - PAN will feel dead compared to ROTATE for the same hand movement`
  );
});

// --- Pinch hysteresis regression -------------------------------------------
//
// Bug: a single frame where tracking noise pushed the pinch distance or
// index-reach a hair past isPinch()'s entry bar (very easy right at a
// "fully closed" pinch, where the tracker's estimate of the touching tips
// is noisiest) made GestureController treat the pinch as released, wiping
// _prevPinchPos and losing the drag's continuity for a frame - which felt
// like the gesture "getting mixed up" mid-drag and not moving much overall.

test("REGRESSION: a single noisy frame just over the pinch threshold, in the middle of an active drag, does not drop the drag", () => {
  const controller = new GestureController({ pinchThreshold: 0.4 });

  const a = pinchLandmarks();
  controller.update([{ landmarks: a, label: "Right" }]); // enter PAN

  const b = pinchLandmarks();
  b[4] = { x: b[4].x + 0.05, y: b[4].y, z: 0 }; // move while pinching
  const dragged = controller.update([{ landmarks: b, label: "Right" }]);
  assert.equal(dragged.state, GestureState.PAN);
  assert.ok(dragged.pan);

  // One noisy frame: thumb/index drift slightly apart, just past the
  // strict entry threshold, but nowhere near fully open.
  const noisy = pinchLandmarks();
  noisy[4] = { x: 0.5, y: 0.42, z: 0 };
  noisy[8] = { x: 0.45, y: 0.4, z: 0 }; // raw distance ~0.05/handScale, still small
  const noisyResult = controller.update([{ landmarks: noisy, label: "Right" }]);
  assert.equal(noisyResult.state, GestureState.PAN); // hysteresis keeps this as PAN

  // Continuing to drag afterward should still produce a delta, not a
  // phantom-jump reset.
  const c = pinchLandmarks();
  c[4] = { x: c[4].x + 0.1, y: c[4].y, z: 0 };
  const resumed = controller.update([{ landmarks: c, label: "Right" }]);
  assert.equal(resumed.state, GestureState.PAN);
  assert.ok(resumed.pan);
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