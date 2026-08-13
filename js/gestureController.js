// gestureController.js
//
// Turns raw hand landmarks (from handTracker.js) into pan / rotate / zoom
// deltas for the 3D viewer. Positions are smoothed with a simple EMA filter
// so hand tremor doesn't turn into jittery model movement.
//
// Gesture rules:
//   Two hands visible               -> ZOOM        (change in distance between palms)
//   One hand, thumb up, rest curled -> THUMBS_UP    (one-shot: wireframe on)
//   One hand, thumb down, rest curl -> THUMBS_DOWN  (one-shot: wireframe off)
//   One hand, thumb + index pinched -> PAN          (drag the pinch point)
//   One hand, "counting" pose       -> SNAP_VIEW    (one-shot: front/back/left/
//     (see VIEW_COUNTS below)                        right/top/bottom/iso)
//   One hand, closed fist           -> FIST         (one-shot: reset view)
//   One hand, open palm             -> ROTATE       (move the palm center)
//   Anything else                   -> IDLE         (no movement)
//
// --- View-snap counting gestures -------------------------------------------
// Front (1) is index-only rather than "thumb only", so it can't be confused
// with THUMBS_UP.
//
// Back/Left (2-3) count up from the thumb side. Right (4) skips the thumb —
// index+middle+ring+pinky is a steadier hold than thumb+index+middle+ring.
// That makes Right just one finger away from a plain open palm (5 up), so
// telling them apart comes down entirely to reading the thumb correctly —
// see MAX_THUMB_RATIO_FOR_RIGHT below.
//
// Top/Bottom/Iso (5-7) count up from the pinky side instead of continuing
// past 5, since "all 5 up" is just an open palm (-> ROTATE).
//
// FIST, THUMBS_UP/DOWN, and SNAP_VIEW are one-shot actions: they fire
// `result.action` once when the pose is first formed, then latch until the
// hand leaves that pose, so holding it doesn't spam the action every frame.
//
// --- Classification order matters -----------------------------------------
// Poses are checked most-specific-first: thumb pose, then pinch, then the
// counting view poses, then fist, then open palm.
//
// Pinch goes before the counting poses because an "OK sign" (thumb+index
// touching, other 3 fingers up) has the same finger pattern as the "7"/ISO
// count — only isPinch()'s thumb/index reach check tells them apart, so it
// needs first look.
//
// Pinch also goes before fist: a real pinch attempt often relaxes the other
// fingers too, which can look like "everything's curled" to isFist(). And
// the counting poses go before fist/open-palm for the same reason — "4"
// (index+middle+ring+pinky) is 4 of 5 fingers up, which would otherwise
// pass the open-palm threshold.
//
// No DOM or MediaPipe dependency here — just plain landmark data, so this
// is unit-testable on its own (see tests/gestureController.test.js).

export const GestureState = {
  IDLE: "IDLE",
  PAN: "PAN (pinch)",
  ROTATE: "ROTATE (open palm)",
  ZOOM: "ZOOM (two hands)",
  FIST: "FIST (reset view)",
  THUMBS_UP: "THUMBS UP (wireframe on)",
  THUMBS_DOWN: "THUMBS DOWN (wireframe off)",
  FRONT: "FRONT (snap view, 1)",
  BACK: "BACK (snap view, 2)",
  LEFT: "LEFT (snap view, 3)",
  RIGHT: "RIGHT (snap view, 4)",
  TOP: "TOP (snap view, 5)",
  BOTTOM: "BOTTOM (snap view, 6)",
  ISO: "ISO (snap view, 7)",
};

export const GestureAction = {
  RESET_VIEW: "RESET_VIEW",
  WIREFRAME_ON: "WIREFRAME_ON",
  WIREFRAME_OFF: "WIREFRAME_OFF",
  SNAP_VIEW: "SNAP_VIEW",
};

// Maps a view name -> the GestureState it reports.
const VIEW_STATE = {
  front: GestureState.FRONT,
  back: GestureState.BACK,
  left: GestureState.LEFT,
  right: GestureState.RIGHT,
  top: GestureState.TOP,
  bottom: GestureState.BOTTOM,
  iso: GestureState.ISO,
};

// The 7 view-snap "counting" poses. Order in each array matches
// fingersExtended()'s return order: [index, middle, ring, pinky, thumb].
// Same hand for both halves — no left/right-hand distinction, just count
// up from the thumb side for 1-4, then count up from the pinky side for
// 5-7 (see the big comment above for why it isn't a straight 1-7 count).
const VIEW_COUNTS = {
  front: [true, false, false, false, false], // 1: index only
  back: [true, false, false, false, true], // 2: thumb + index
  left: [true, true, false, false, true], // 3: thumb + index + middle
  right: [true, true, true, true, false], // 4: index + middle + ring + pinky
  top: [false, false, false, true, false], // 5: pinky only
  bottom: [false, false, true, true, false], // 6: pinky + ring
  iso: [false, true, true, true, false], // 7: pinky + ring + middle
};

// Simple exponential moving average filter for 1D smoothing.
export class EMA {
  constructor(alpha = 0.4) {
    this.alpha = alpha;
    this.value = null;
  }

  update(newValue) {
    this.value =
      this.value === null ? newValue : this.alpha * newValue + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

// Straight-line distance between two {x, y} points. z is ignored, same as
// the original Python version, since depth from a single webcam is noisy.
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Distance from the wrist (landmark 0) to the middle-finger knuckle
// (landmark 9). Used to normalize the pinch distance so it works the same
// whether the hand is close to the camera or far away.
export function handScale(landmarks) {
  return Math.max(dist(landmarks[0], landmarks[9]), 1e-6);
}

// How much farther (as a ratio) a fingertip must sit from the wrist than
// its own pip joint before it counts as "extended" rather than curled.
// Slightly above 1.0 so borderline/noisy landmarks don't flicker.
const FINGER_EXTENSION_RATIO = 1.1;

// How long the thumb must measure — tip (landmark 4) to its own MCP knuckle
// (landmark 2), normalized by hand scale — before it counts as "extended"
// rather than curled/tucked.
const MIN_THUMB_EXTENSION_RATIO = 0.45;

// Is the thumb straightened out, or folded back toward its own base?
//
// This only looks at the thumb's own tip-to-MCP length, not its position
// relative to the wrist or palm. A curled thumb is always short (the tip
// doubles back near its own base), and a straightened one is always close
// to full length — true no matter how the hand is rotated or which side of
// the frame it's on. Same idea as the tip-vs-pip test the other 4 fingers
// use below, just anchored to the thumb's own base since it doesn't fold
// the same way they do.
export function isThumbExtended(landmarks) {
  const scale = handScale(landmarks);
  return dist(landmarks[4], landmarks[2]) / scale >= MIN_THUMB_EXTENSION_RATIO;
}

// Returns [index, middle, ring, pinky, thumb] booleans, in that order.
//
// The 4 main fingers are classified by comparing each fingertip's distance
// from the wrist (landmark 0) against its own pip joint's distance from the
// wrist, rather than a raw tip.y < pip.y comparison in image space. That
// distance comparison holds regardless of how the hand is rotated toward
// the camera; a plain y-comparison can flip when the hand is angled (e.g.
// fingers pointing down and toward the lens), reading curled fingers as
// extended.
//
// The thumb uses isThumbExtended() instead, since it doesn't fold the same
// way the other fingers do.
export function fingersExtended(landmarks, label) {
  const wrist = landmarks[0];
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  const extended = tips.map((tip, i) => {
    const tipDist = dist(landmarks[tip], wrist);
    const pipDist = dist(landmarks[pips[i]], wrist);
    return tipDist > pipDist * FINGER_EXTENSION_RATIO;
  });

  extended.push(isThumbExtended(landmarks));

  return extended;
}

export function isOpenPalm(landmarks, label) {
  return fingersExtended(landmarks, label).filter(Boolean).length >= 4;
}

// How far the index fingertip must sit from its own knuckle (landmark 5),
// normalized by hand scale, before it counts as "reaching" toward the thumb
// rather than just resting curled. A curled index tip barely moves from its
// own knuckle; a real pinch — even a loose, not-fully-closed one — always
// reaches noticeably away from the knuckle toward the thumb. This is also
// what separates an "OK sign" pinch from the "7"/ISO counting pose, which
// otherwise has the exact same fingers-up pattern.
const MIN_INDEX_REACH_FOR_PINCH = 0.2;

// Hysteresis for staying in PAN once a pinch is active: a single noisy
// frame that dips just past isPinch()'s entry bar (easy to hit right when
// the tips are touching, where tracking is noisiest) would otherwise read
// as a release, reset the drag, and cost a frame of motion. So the strict
// isPinch() check is only required to *enter* PAN — once active, staying
// in PAN just needs the looser distance-only bar below.
export const PINCH_RELEASE_MULTIPLIER = 1.4;

export function isPinch(landmarks, threshold = 0.4) {
  const scale = handScale(landmarks);
  const distance = dist(landmarks[4], landmarks[8]) / scale;

  // A fist facing the camera can put the thumb tip and the folded index
  // tip right on top of each other by pure perspective, with neither
  // finger doing anything pinch-like. Requiring the index to actually
  // reach away from its own knuckle rules that out.
  const indexReach = dist(landmarks[8], landmarks[5]) / scale;
  const reaching = indexReach > MIN_INDEX_REACH_FOR_PINCH;

  return { pinching: distance < threshold && reaching, distance };
}

// A fist is "the four main fingers curled" — the thumb is ignored here
// since isThumbPose() and isPinch() (both checked earlier) already claim
// their own thumb cases. A relaxed fist often rests with the thumb up
// along the curled fingers rather than tucked flush, and that's still a
// fist, not a thumbs-up.
export function isFist(landmarks, label) {
  const [index, middle, ring, pinky] = fingersExtended(landmarks, label);
  return !index && !middle && !ring && !pinky;
}

// How far the thumb's direction (MCP -> tip) is allowed to lean away from
// straight up/down, in degrees, before it no longer counts as "up" or
// "down". This is what stops a thumb pointing mostly sideways (left/right)
// from ever being read as THUMBS_UP just because it's a little higher than
// its knuckle.
const THUMB_ANGLE_FROM_VERTICAL_DEG = 40;

// THUMBS_UP/DOWN needs a stricter bar than the general isThumbExtended().
// The general 0.45 threshold just means "unfolded a bit," which is also
// true mid-pinch as the thumb swings toward the index finger. A deliberate
// thumbs-up should be unambiguous, so this requires close to full
// extension before claiming the pose.
const MIN_THUMB_EXTENSION_RATIO_FOR_THUMB_POSE = 1.0;

function isThumbClearlyExtended(landmarks) {
  return dist(landmarks[4], landmarks[2]) / handScale(landmarks) >= MIN_THUMB_EXTENSION_RATIO_FOR_THUMB_POSE;
}

// Thumbs up/down: the four main fingers curled, AND the thumb clearly
// pulled away from the fist, AND pointing close to straight up or down
// (not sideways). Returns "up" | "down" | null.
//
// Both checks are done with vectors/distances rather than raw x/y
// comparisons against the wrist or hand label, so this works the same
// whether the hand is tilted, mirrored, or left vs. right.
export function isThumbPose(landmarks, label) {
  const [index, middle, ring, pinky] = fingersExtended(landmarks, label);
  if (index || middle || ring || pinky) return null;

  if (!isThumbClearlyExtended(landmarks)) return null;

  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];

  // The thumb's own direction (its MCP-to-tip vector), not its position
  // relative to the wrist, determines up/down/sideways.
  const dx = thumbTip.x - thumbMcp.x;
  const dy = thumbTip.y - thumbMcp.y; // image y grows downward
  const angleFromVertical = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  if (angleFromVertical > THUMB_ANGLE_FROM_VERTICAL_DEG) return null;

  return dy < 0 ? "up" : "down";
}

// RIGHT (4 fingers, no thumb) is one bit away from an open palm (5
// fingers) — they only differ on the thumb. isThumbExtended()'s normal
// 0.45 cutoff is fine for telling "roughly extended" from "roughly
// curled", but it's not a wide enough margin for this specific pair: a
// relaxed open hand can have its thumb sitting close enough to that line
// that one so-so frame reads it as "not extended," which then matches
// RIGHT's pattern exactly and steals the gesture from ROTATE.
//
// So RIGHT gets its own, stricter bar for "thumb is actually tucked" —
// well under 0.45, not just on the other side of it. Anything in between
// just falls through to ROTATE/IDLE instead of guessing.
const MAX_THUMB_RATIO_FOR_RIGHT = 0.3;

// Matches the 4 main fingers + thumb against the VIEW_COUNTS table above.
// Returns a view name ("front", "iso", ...) or null.
export function viewPose(landmarks, label) {
  const pattern = fingersExtended(landmarks, label);
  for (const [name, expected] of Object.entries(VIEW_COUNTS)) {
    if (!expected.every((v, i) => v === pattern[i])) continue;

    if (name === "right") {
      const thumbRatio = dist(landmarks[4], landmarks[2]) / handScale(landmarks);
      if (thumbRatio >= MAX_THUMB_RATIO_FOR_RIGHT) continue; // thumb isn't clearly tucked, let ROTATE have it
    }

    return name;
  }
  return null;
}

export class GestureController {
  // panGain sits roughly half of rotateGain by design: cadViewer.js scales
  // pan deltas by PAN_UNIT=0.01 vs rotate's ROTATE_UNIT=0.005, so matching
  // gains at that ratio keeps pan feeling as responsive as rotate for the
  // same hand movement. (cadViewer.js also caps how far a drag can carry
  // the model, so a high gain moves it fast without launching it off-screen.)
  constructor({ pinchThreshold = 0.4, panGain = 125.0, rotateGain = 250.0, zoomGain = 8.0 } = {}) {
    this.pinchThreshold = pinchThreshold;
    this.panGain = panGain;
    this.rotateGain = rotateGain;
    this.zoomGain = zoomGain;

    this.posXFilter = new EMA(0.4);
    this.posYFilter = new EMA(0.4);
    this.twoHandDistFilter = new EMA(0.3);

    this._prevPinchPos = null;
    this._prevPalmPos = null;
    this._prevTwoHandDist = null;
    this.state = GestureState.IDLE;

    // Latches so FIST / THUMBS_UP / THUMBS_DOWN / SNAP_VIEW fire `action`
    // once per pose instead of every single frame the pose is held.
    this._fistLatched = false;
    this._thumbLatched = null; // null | "up" | "down"
    this._viewLatched = null; // null | "front" | "back" | "left" | "right" | "top" | "bottom" | "iso"

    // Whether PAN was active as of the previous frame - drives the
    // hysteresis in update() (see PINCH_RELEASE_MULTIPLIER above).
    this._pinchActive = false;
  }

  _resetSingleHand() {
    this._prevPinchPos = null;
    this._prevPalmPos = null;
    this._pinchActive = false;
    this.posXFilter.reset();
    this.posYFilter.reset();
  }

  _resetTwoHand() {
    this._prevTwoHandDist = null;
    this.twoHandDistFilter.reset();
  }

  // Clears every one-shot pose latch. Called whenever hands drop out
  // entirely, so re-entering a pose later always re-fires its action
  // instead of silently staying latched from an earlier frame.
  _resetLatches() {
    this._fistLatched = false;
    this._thumbLatched = null;
    this._viewLatched = null;
  }

  // handsData: array of { landmarks: [{x,y,z} x21], label: "Left"|"Right" }
  // Returns { state, pan: {dx,dy}|null, rotate: {dx,dy}|null, zoom: number|null,
  //           pinchDistance: number|null, view: string|null,
  //           action: GestureAction|null }
  update(handsData) {
    const result = {
      state: GestureState.IDLE,
      pan: null,
      rotate: null,
      zoom: null,
      pinchDistance: null, // normalized thumb-index distance; for a debug/calibration readout
      view: null, // view name while a SNAP_VIEW pose is held, else null
      action: null, // one of GestureAction, fired once on the rising edge of a pose
    };

    if (handsData.length === 2) {
      const c0 = handsData[0].landmarks[9];
      const c1 = handsData[1].landmarks[9];
      const smoothed = this.twoHandDistFilter.update(dist(c0, c1));

      if (this._prevTwoHandDist !== null) {
        result.zoom = (smoothed - this._prevTwoHandDist) * this.zoomGain;
      }
      this._prevTwoHandDist = smoothed;
      result.state = GestureState.ZOOM;

      this._resetSingleHand();
      this._resetLatches();
      this.state = result.state;
      return result;
    }

    this._resetTwoHand();

    if (handsData.length === 1) {
      const { landmarks: lm, label } = handsData[0];

      // 1. Thumb up/down is the most specific pose (all 4 main fingers
      //    curled AND thumb clearly vertical), so it's checked first.
      const thumbPose = isThumbPose(lm, label);
      if (thumbPose) {
        this._resetSingleHand();
        this._fistLatched = false;
        this._viewLatched = null;

        if (this._thumbLatched !== thumbPose) {
          result.action = thumbPose === "up" ? GestureAction.WIREFRAME_ON : GestureAction.WIREFRAME_OFF;
          this._thumbLatched = thumbPose;
        }
        result.state = thumbPose === "up" ? GestureState.THUMBS_UP : GestureState.THUMBS_DOWN;
        this.state = result.state;
        return result;
      }
      this._thumbLatched = null;

      // 2. Pinch next, before the counting poses and fist. An "OK sign"
      //    (thumb+index touching, other 3 up) has the same finger pattern
      //    as the "7"/ISO count — isPinch()'s reach check is what tells
      //    them apart, so it needs to run first.
      const enterCheck = isPinch(lm, this.pinchThreshold);
      const distance = enterCheck.distance;
      result.pinchDistance = distance;

      // Hysteresis: once a pinch is driving PAN, only require the looser
      // distance-only bar to stay classified as PAN (see
      // PINCH_RELEASE_MULTIPLIER above).
      const pinching = this._pinchActive
        ? distance < this.pinchThreshold * PINCH_RELEASE_MULTIPLIER
        : enterCheck.pinching;
      this._pinchActive = pinching;

      if (pinching) {
        this._fistLatched = false;
        this._viewLatched = null;
        this._prevPalmPos = null;

        const midX = (lm[4].x + lm[8].x) / 2;
        const midY = (lm[4].y + lm[8].y) / 2;
        const sx = this.posXFilter.update(midX);
        const sy = this.posYFilter.update(midY);

        if (this._prevPinchPos !== null) {
          result.pan = {
            dx: (sx - this._prevPinchPos.x) * this.panGain,
            dy: (sy - this._prevPinchPos.y) * this.panGain,
          };
        }
        this._prevPinchPos = { x: sx, y: sy };
        result.state = GestureState.PAN;
        this.state = result.state;
        return result;
      }

      // 3. Counting view-snap poses: exact match against all 5 finger
      //    booleans (see VIEW_COUNTS). Checked before the open-palm
      //    fallback since "4" is otherwise "almost open".
      const view = viewPose(lm, label);
      if (view) {
        this._resetSingleHand();
        this._fistLatched = false;

        if (this._viewLatched !== view) {
          result.action = GestureAction.SNAP_VIEW;
          this._viewLatched = view;
        }
        result.view = view;
        result.state = VIEW_STATE[view];
        this.state = result.state;
        return result;
      }
      this._viewLatched = null;

      // 4. Fist: all 4 main fingers curled (thumb ignored — already claimed
      //    above by thumb-up/down and pinch).
      if (isFist(lm, label)) {
        this._resetSingleHand();

        if (!this._fistLatched) {
          result.action = GestureAction.RESET_VIEW;
          this._fistLatched = true;
        }
        result.state = GestureState.FIST;
        this.state = result.state;
        return result;
      }
      this._fistLatched = false;

      // An unfinished pinch attempt still leaves the other 4 fingers
      // reading as extended, so require the fingers to be clearly spread
      // out before falling through to open-palm/ROTATE.
      const clearlyNotPinching = distance > this.pinchThreshold * 1.5;

      if (clearlyNotPinching && isOpenPalm(lm, label)) {
        this._prevPinchPos = null;
        this.posXFilter.reset();
        this.posYFilter.reset();

        const px = lm[9].x;
        const py = lm[9].y;
        if (this._prevPalmPos !== null) {
          result.rotate = {
            dx: (px - this._prevPalmPos.x) * this.rotateGain,
            dy: (py - this._prevPalmPos.y) * this.rotateGain,
          };
        }
        this._prevPalmPos = { x: px, y: py };
        result.state = GestureState.ROTATE;
      } else {
        this._resetSingleHand();
        result.state = GestureState.IDLE;
      }
    } else {
      this._resetSingleHand();
      this._resetLatches();
    }

    this.state = result.state;
    return result;
  }
}