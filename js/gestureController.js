// gestureController.js
//
// Turns raw hand landmarks (from handTracker.js) into pan / rotate / zoom
// deltas that the 3D viewer can use. Includes an exponential moving average
// (EMA) filter so small hand tremors don't cause jittery model movement.
//
// Gesture rules:
//   Two hands visible               -> ZOOM       (change in distance between palms)
//   One hand, closed fist           -> FIST        (one-shot: reset view)
//   One hand, thumb up, rest curled -> THUMBS_UP    (one-shot: wireframe on)
//   One hand, thumb down, rest curl -> THUMBS_DOWN  (one-shot: wireframe off)
//   One hand, thumb + index pinched -> PAN          (drag the pinch point)
//   One hand, open palm             -> ROTATE       (move the palm center)
//   Anything else                   -> IDLE         (no movement)
//
// FIST and THUMBS_UP/DOWN are "action" gestures, not continuous ones: they
// fire `result.action` exactly once when the pose is first formed (a rising
// edge), then latch until the hand leaves that pose, so holding a fist
// doesn't spam reset-view every single frame.
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
};

export const GestureAction = {
  RESET_VIEW: "RESET_VIEW",
  WIREFRAME_ON: "WIREFRAME_ON",
  WIREFRAME_OFF: "WIREFRAME_OFF",
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
// thumb-extended case before it falls through to a generic fist.
export function isFist(landmarks, label) {
  const [index, middle, ring, pinky] = fingersExtended(landmarks, label);
  return !index && !middle && !ring && !pinky;
}

// Thumbs up/down: the four main fingers curled AND the thumb clearly
// extended AND pointing mostly up or down (not sideways). Returns
// "up" | "down" | null. The vertical margin is normalized by hand scale so
// it works the same regardless of distance from the camera.
export function isThumbPose(landmarks, label) {
  const extended = fingersExtended(landmarks, label);
  const [index, middle, ring, pinky, thumbExtended] = extended;
  if (index || middle || ring || pinky || !thumbExtended) return null;

  const scale = handScale(landmarks);
  const verticalOffset = (landmarks[0].y - landmarks[4].y) / scale; // + = thumb above wrist
  const MARGIN = 0.6;

  if (verticalOffset > MARGIN) return "up";
  if (verticalOffset < -MARGIN) return "down";
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

    // Latches so FIST / THUMBS_UP / THUMBS_DOWN fire `action` once per pose
    // instead of every single frame the pose is held.
    this._fistLatched = false;
    this._thumbLatched = null; // null | "up" | "down"
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

  // handsData: array of { landmarks: [{x,y,z} x21], label: "Left"|"Right" }
  // Returns { state, pan: {dx,dy}|null, rotate: {dx,dy}|null, zoom: number|null,
  //           pinchDistance: number|null }
  update(handsData) {
    const result = {
      state: GestureState.IDLE,
      pan: null,
      rotate: null,
      zoom: null,
      pinchDistance: null, // normalized thumb-index distance; for a debug/calibration readout
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
      this._fistLatched = false;
      this._thumbLatched = null;
      this.state = result.state;
      return result;
    }

    this._resetTwoHand();

    if (handsData.length === 1) {
      const { landmarks: lm, label } = handsData[0];

      const thumbPose = isThumbPose(lm, label);
      if (thumbPose) {
        this._resetSingleHand();
        this._fistLatched = false;

        if (this._thumbLatched !== thumbPose) {
          result.action = thumbPose === "up" ? GestureAction.WIREFRAME_ON : GestureAction.WIREFRAME_OFF;
          this._thumbLatched = thumbPose;
        }
        result.state = thumbPose === "up" ? GestureState.THUMBS_UP : GestureState.THUMBS_DOWN;
        this.state = result.state;
        return result;
      }
      this._thumbLatched = null;

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

      const { pinching, distance } = isPinch(lm, this.pinchThreshold);
      result.pinchDistance = distance;

      // A pinch attempt that doesn't fully close (common with webcam noise
      // and single-camera depth ambiguity) still leaves the other 4 fingers
      // reading as "extended", so without this buffer it silently falls
      // through to isOpenPalm() and gets misread as ROTATE instead of just
      // not registering. Require the fingers to be clearly spread out
      // (well past the pinch threshold) before allowing that fallback.
      const clearlyNotPinching = distance > this.pinchThreshold * 1.5;

      if (pinching) {
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
      } else if (clearlyNotPinching && isOpenPalm(lm, label)) {
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
      this._fistLatched = false;
      this._thumbLatched = null;
    }

    this.state = result.state;
    return result;
  }
}