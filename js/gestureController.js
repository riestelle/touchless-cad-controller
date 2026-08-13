// gestureController.js
//
// Turns raw hand landmarks (from handTracker.js) into pan / rotate / zoom
// deltas that the 3D viewer can use. Includes an exponential moving average
// (EMA) filter so small hand tremors don't cause jittery model movement.
//
// Gesture rules:
//   Two hands visible               -> ZOOM        (change in distance between palms)
//   One hand, thumb up, rest curled -> THUMBS_UP    (one-shot: wireframe on)
//   One hand, thumb down, rest curl -> THUMBS_DOWN  (one-shot: wireframe off)
//   One hand, thumb + index pinched -> PAN          (drag the pinch point)
//   One hand, "counting" pose       -> SNAP_VIEW    (one-shot: front/back/left/
//     (see VIEW_COUNTS below)                        right/top/bottom/iso)
//   One hand, closed fist           -> FIST         (one-shot: reset view)
//   One hand, open palm             -> ROTATE        (move the palm center)
//   Anything else                   -> IDLE          (no movement)
//
// --- View-snap counting gestures -------------------------------------------
// Views 1-4 count up starting from the thumb side of the hand (thumb, then
// thumb+index, thumb+index+middle, thumb+index+middle+ring). Views 5-7
// switch to counting down from the pinky side instead (pinky, pinky+ring,
// pinky+ring+middle) rather than continuing to 5 fingers, since "all 5 up"
// is indistinguishable from a plain open palm (-> ROTATE). See VIEW_COUNTS.
//
// IMPORTANT CAVEAT: "1" (front) is defined as "thumb up, other 4 curled" —
// which is the exact same hand shape as THUMBS_UP. There is no landmark
// signal that tells those two poses apart; they are the same pose. Thumb
// pose is checked first (see ordering below), so making that shape always
// toggles wireframe, never snaps to Front. Front is still reachable via the
// "1" key or the on-screen button (see main.js) — just not via this exact
// gesture. Every other count (2-7) is unambiguous.
//
// FIST, THUMBS_UP/DOWN, and SNAP_VIEW are "action" gestures, not continuous
// ones: they fire `result.action` exactly once when the pose is first
// formed (a rising edge), then latch until the hand leaves that pose, so
// holding a pose doesn't spam the action every single frame.
//
// --- Classification order matters -----------------------------------------
// Poses are checked most-specific-first: thumb pose, then pinch, then the
// counting view poses, then fist, then open palm. This used to be wrong
// (fist was checked before pinch), which meant a real pinch attempt — where
// the index finger curls in toward the thumb and, on a lot of hands, the
// other fingers relax slightly at the same time — could satisfy isFist()'s
// "all four main fingers curled" test before isPinch() ever got a chance to
// run, so pinches misfired as a fist/reset. Checking the most specific,
// least-ambiguous signal (thumb-to-index distance) before the broadest one
// (are all fingers curled) fixes that class of misclassification generally,
// not just for this one pair. Counting poses are checked before fist/open
// palm for the same reason: e.g. the "4" pose (thumb+index+middle+ring up)
// has 4 of 5 fingers extended, which would otherwise satisfy the open-palm
// threshold and misfire as ROTATE.
//
// This file has no dependency on the DOM or on MediaPipe. It only works
// with plain landmark data, so it can be unit tested on its own
// (see tests/gestureController.test.js).

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
  front: [false, false, false, false, true], // 1: thumb only
  back: [true, false, false, false, true], // 2: thumb + index
  left: [true, true, false, false, true], // 3: thumb + index + middle
  right: [true, true, true, false, true], // 4: thumb + index + middle + ring
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

// Returns [index, middle, ring, pinky, thumb] booleans, in that order.
export function fingersExtended(landmarks, label) {
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  const extended = tips.map((tip, i) => landmarks[tip].y < landmarks[pips[i]].y);

  // The thumb doesn't fold the same way as the other fingers, so it needs
  // its own left/right check instead of a simple tip-above-knuckle test.
  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];
  const thumbExtended = label === "Right" ? thumbTip.x < thumbMcp.x : thumbTip.x > thumbMcp.x;
  extended.push(thumbExtended);

  return extended;
}

export function isOpenPalm(landmarks, label) {
  return fingersExtended(landmarks, label).filter(Boolean).length >= 4;
}

export function isPinch(landmarks, threshold = 0.4) {
  const scale = handScale(landmarks);
  const distance = dist(landmarks[4], landmarks[8]) / scale;
  return { pinching: distance < threshold, distance };
}

// A fist is "the four main fingers curled" — the thumb is intentionally
// ignored here so isThumbPose() (checked first, see below) can claim the
// thumb-extended case, and isPinch() (also checked first) can claim the
// thumb-near-index case, before either falls through to a generic fist.
//
// A real, relaxed fist very often rests with the thumb sitting up along the
// side of the curled fingers rather than tucked flush against the palm —
// that's still a fist, not a thumbs-up. isThumbPose() below requires the
// thumb to be clearly pulled away from the hand AND close to vertical
// before it claims a pose, specifically so a normal fist's resting thumb
// falls through to here instead of being misread as THUMBS_UP.
export function isFist(landmarks, label) {
  const [index, middle, ring, pinky] = fingersExtended(landmarks, label);
  return !index && !middle && !ring && !pinky;
}

// How far the thumb tip must sit from the palm center (landmark 9),
// normalized by hand scale, before it counts as "extended" rather than
// resting against a curled fist. Distance-from-palm is used instead of a
// left/right x-position check because a distance is the same regardless of
// which hand is shown, whether the video is mirrored, or how the hand is
// rotated in frame — all things a simple "tip.x vs mcp.x" comparison gets
// wrong in practice.
const THUMB_EXTENSION_THRESHOLD = 0.75;

// How far the thumb's direction (MCP -> tip) is allowed to lean away from
// straight up/down, in degrees, before it no longer counts as "up" or
// "down". This is what stops a thumb pointing mostly sideways (left/right)
// from ever being read as THUMBS_UP just because it's a little higher than
// its knuckle.
const THUMB_ANGLE_FROM_VERTICAL_DEG = 40;

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

  const scale = handScale(landmarks);
  const thumbTip = landmarks[4];
  const thumbMcp = landmarks[2];
  const palmCenter = landmarks[9];

  // The thumb must be clearly sticking out from the fist, not resting
  // against it.
  const extension = dist(thumbTip, palmCenter) / scale;
  if (extension < THUMB_EXTENSION_THRESHOLD) return null;

  // The thumb's own direction (its MCP-to-tip vector), not its position
  // relative to the wrist, determines up/down/sideways.
  const dx = thumbTip.x - thumbMcp.x;
  const dy = thumbTip.y - thumbMcp.y; // image y grows downward
  const angleFromVertical = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  if (angleFromVertical > THUMB_ANGLE_FROM_VERTICAL_DEG) return null;

  return dy < 0 ? "up" : "down";
}

// Matches the 4 main fingers + thumb against the VIEW_COUNTS table (see the
// big comment at the top of the file). Returns a view name ("front",
// "iso", ...) or null.
//
// For the 4 main fingers this uses fingersExtended()'s general-purpose
// tip-vs-pip test. For the thumb it deliberately does NOT use
// fingersExtended()'s crude left/right x-position check — that check reads
// a normal fist's resting thumb (up along the side, not tucked flush) as
// "extended" too easily, which would make count "1" (front) misfire on a
// plain fist. Instead it reuses the same distance-from-palm test as
// isThumbPose(), so "extended" means the same thing in both places.
export function viewPose(landmarks, label) {
  const [index, middle, ring, pinky] = fingersExtended(landmarks, label);

  const scale = handScale(landmarks);
  const thumbExtension = dist(landmarks[4], landmarks[9]) / scale;
  const thumb = thumbExtension >= THUMB_EXTENSION_THRESHOLD;

  const pattern = [index, middle, ring, pinky, thumb];
  for (const [name, expected] of Object.entries(VIEW_COUNTS)) {
    if (expected.every((v, i) => v === pattern[i])) return name;
  }
  return null;
}

export class GestureController {
  constructor({ pinchThreshold = 0.4, panGain = 2.5, rotateGain = 250.0, zoomGain = 8.0 } = {}) {
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
  }

  _resetSingleHand() {
    this._prevPinchPos = null;
    this._prevPalmPos = null;
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

      // 2. Pinch next: thumb-to-index distance is checked before the broad
      //    "are all 4 fingers curled" fist test, so a pinch attempt (where
      //    the index curls toward the thumb and the other fingers often
      //    relax a little too) is never swallowed by isFist().
      const { pinching, distance } = isPinch(lm, this.pinchThreshold);
      result.pinchDistance = distance;

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

      // 3. Counting view-snap poses: checked before fist. Fist requires
      //    *zero* fingers extended so there's no ambiguity between the two,
      //    but checking this before the open-palm fallback below matters
      //    since some counts (e.g. "4") are otherwise "almost open".
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

      // A pinch attempt that doesn't fully close (common with webcam noise
      // and single-camera depth ambiguity) still leaves the other 4 fingers
      // reading as "extended", so without this buffer it silently falls
      // through to isOpenPalm() and gets misread as ROTATE instead of just
      // not registering. Require the fingers to be clearly spread out
      // (well past the pinch threshold) before allowing that fallback.
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