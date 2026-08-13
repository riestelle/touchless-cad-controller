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
// Front (1) is index-only, deliberately excluding the thumb: an earlier
// version used "thumb only" for Front, which is the exact same hand shape
// as THUMBS_UP, so the two constantly got mixed up. Using index-only avoids
// the thumb altogether, so Front no longer collides with the wireframe
// toggle at all.
//
// Back/Left (2-3) still count up from the thumb side (thumb+index,
// thumb+index+middle). Right (4) intentionally skips the thumb too — a
// four-finger "index+middle+ring+pinky" hold (no thumb) is easier to form
// and hold steady than "thumb+index+middle+ring" was.
//
// Because Right doesn't require the thumb to be extended, its pattern
// (index+middle+ring+pinky up, thumb curled) sits right next to ROTATE's
// open-palm pattern (all 5 up) — the two differ only in the thumb. Getting
// that thumb read right is what used to make ROTATE and Right collide: see
// isThumbExtended()'s comment for the full story of that bug and the fix.
// With a single, own-length-based extension test shared by isOpenPalm()
// and viewPose(), Right only wins when the thumb is genuinely folded back
// toward its own base, not just resting somewhere short of a dramatic
// sideways fling — so an ordinary open, relaxed hand reads as ROTATE, and
// Right requires an actually curled thumb. Counting poses are still
// checked before the fist/open-palm fallback (see below), so a genuinely
// curled-thumb four-finger hold still wins over ROTATE, as intended.
//
// Top/Bottom/Iso (5-7) count up from the pinky side instead of continuing
// to 5 fingers, since "all 5 up" is indistinguishable from a plain open
// palm (-> ROTATE). See VIEW_COUNTS for the exact patterns.
//
// FIST, THUMBS_UP/DOWN, and SNAP_VIEW are "action" gestures, not continuous
// ones: they fire `result.action` exactly once when the pose is first
// formed (a rising edge), then latch until the hand leaves that pose, so
// holding a pose doesn't spam the action every single frame.
//
// --- Classification order matters -----------------------------------------
// Poses are checked most-specific-first: thumb pose, then pinch, then the
// counting view poses, then fist, then open palm.
//
// Pinch is checked before the counting view poses because the "OK sign"
// pinch shape (thumb+index tips touching, other 3 fingers raised) has the
// exact same 5-finger boolean pattern as the "7"/ISO counting pose (see
// VIEW_COUNTS.iso) once the 4 main fingers are read generically. The only
// thing that tells them apart is whether the thumb and index are actually
// touching/reaching for each other — which is what isPinch() checks (see
// its comment) — so pinch must get first look, or a genuine OK-sign pinch
// gets silently swallowed as an ISO view-snap instead. A real "7" count,
// where the index just rests curled without ever reaching for the thumb,
// still fails isPinch()'s reach check and falls through to the view-pose
// check correctly.
//
// Pinch is checked before fist for the same kind of reason: a real pinch
// attempt — where the index finger curls in toward the thumb and, on a lot
// of hands, the other fingers relax slightly at the same time — could
// otherwise satisfy isFist()'s "all four main fingers curled" test before
// isPinch() ever got a chance to run, so pinches misfired as a fist/reset.
// Checking the most specific, least-ambiguous signal (thumb-to-index
// distance, combined with the index-reach check) before the broadest one
// (are all fingers curled) fixes that class of misclassification generally.
// Counting poses are checked before fist/open palm for the same reason:
// e.g. the "4" pose (index+middle+ring+pinky up) has 4 of 5 fingers
// extended, which would otherwise satisfy the open-palm threshold and
// misfire as ROTATE.
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
// rather than curled/tucked. See isThumbExtended() below for why this
// replaces both the old left/right x-position check and the old
// distance-from-palm-center check.
const MIN_THUMB_EXTENSION_RATIO = 0.45;

// Is the thumb straightened out, or folded back toward its own base?
//
// This deliberately does NOT look at where the tip sits relative to the
// wrist, the palm center, or a left/right x-coordinate — only at the
// thumb's own tip-to-MCP length. A folded/curled thumb is always short
// (the tip doubles back near its own base) no matter which way the hand is
// rotated or which side of the frame it's on; a straightened thumb is
// always close to its full length, even when it's only resting moderately
// out to the side rather than flung out dramatically. That makes this
// check both rotation-invariant and independent of hand label/mirroring —
// same spirit as the tip-vs-pip-from-wrist test used for the other 4
// fingers below, just anchored to the thumb's own base instead of the
// wrist, since the thumb doesn't fold the same way the other fingers do.
//
// This replaces two earlier, inconsistent thumb checks that used to live
// in different places (see git history / the classification-order comment
// near VIEW_COUNTS): a left/right x-position check in fingersExtended(),
// and a separate distance-from-palm-center check in viewPose(). The two
// disagreed constantly on an ordinary relaxed open hand — the x-check
// called the thumb "extended" (correctly), while the distance-from-palm
// check called it "not extended" unless the thumb was flung dramatically
// out to the side (past 0.75x hand scale from the palm center), because a
// merely-unfolded-but-not-hyperextended thumb often doesn't reach that far
// from the palm. Since ROTATE (ISOPEN_PALM) trusted the lenient x-check but
// the "4"/RIGHT view-snap pattern trusted the strict distance check, a
// completely normal open-palm ROTATE gesture would read as "thumb tucked"
// for view-snap purposes and get hijacked by SNAP_VIEW RIGHT, since
// counting poses are checked before the open-palm fallback. Using one
// consistent, own-length-based test everywhere fixes that collision.
export function isThumbExtended(landmarks) {
  const scale = handScale(landmarks);
  return dist(landmarks[4], landmarks[2]) / scale >= MIN_THUMB_EXTENSION_RATIO;
}

// Returns [index, middle, ring, pinky, thumb] booleans, in that order.
//
// The 4 main fingers are classified by comparing each fingertip's distance
// from the wrist (landmark 0) to its own pip joint's distance from the
// wrist — NOT by a raw tip.y < pip.y screen-space comparison. A curled
// finger folds its tip back toward the palm/wrist no matter how the hand
// is rotated in the camera frame, so this distance comparison is
// rotation-invariant. The old y-only check silently flips when the hand's
// "up" direction is rotated relative to the camera — e.g. a hand held with
// the fingers pointing down and toward the lens (as in a thumbs-down shown
// front-on, folded fingers facing the camera) can have curled fingertips
// that still land above their pip joints in image-y, misreading folded
// fingers as extended and breaking poses like THUMBS_DOWN and FIST that
// depend on "all 4 main fingers curled".
//
// The thumb uses isThumbExtended() instead — see its comment for why it
// needs an own-length test rather than either of the above.
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

// How far the index fingertip must sit from its OWN knuckle (landmark 5),
// normalized by hand scale, before it counts as "reaching" toward the thumb
// rather than just resting curled in a fist. A resting/curled index tip
// barely moves from its own knuckle at all (it folds back on itself); a
// deliberate pinch — even an imprecise, "not fully closed" webcam one —
// always involves the index reaching noticeably away from its knuckle to
// meet the thumb.
//
// This same check is also what tells a deliberate "OK sign" pinch (thumb
// and index tips touching, other 3 fingers raised) apart from the "7"/ISO
// counting pose, which looks identical at the level of "which fingers are
// up" (see the ordering comment near the top of this file and
// VIEW_COUNTS.iso): a real OK sign has the index reaching for the thumb,
// while a real "7" count just leaves the index resting curled.
const MIN_INDEX_REACH_FOR_PINCH = 0.2;

// Once a pinch is actively driving PAN, a single noisy frame that dips just
// under isPinch()'s entry bar (distance ticking a hair over threshold, or
// reach ticking a hair under MIN_INDEX_REACH_FOR_PINCH - both easily caused
// by ordinary webcam/MediaPipe jitter, especially at a "fully closed" pinch
// where the thumb and index tips are right on top of each other and the
// tracker's estimate of exactly where they are gets noisiest) is enough to
// make GestureController.update() treat the pinch as released. A release
// resets _prevPinchPos, so the very next frame - even though the person
// never actually let go - starts the drag over from scratch with no delta.
// Over a real multi-second drag this repeatedly throws away motion and
// makes the pan feel like it "loses" the gesture and grabs something else
// (FIST/ROTATE/IDLE) for a frame, i.e. exactly the "gets mixed up" feeling.
//
// PINCH_RELEASE_MULTIPLIER fixes this with hysteresis (a Schmitt trigger):
// isPinch()'s strict distance+reach check is still what's required to
// *enter* PAN, but once active, GestureController only checks the looser
// distance-only bar below to *stay* in PAN, so one noisy frame right at the
// boundary doesn't chop a continuous drag into pieces.
export const PINCH_RELEASE_MULTIPLIER = 1.4;

export function isPinch(landmarks, threshold = 0.4) {
  const scale = handScale(landmarks);
  const distance = dist(landmarks[4], landmarks[8]) / scale;

  // Guard against a resting fist whose thumb happens to land close to the
  // curled index tip in the 2D image — common when the knuckles face the
  // camera (a fist "punching" toward the lens), where perspective can put
  // the thumb tip and the folded index tip right on top of each other even
  // though neither finger is doing anything pinch-like. That proximity is
  // coincidental, not deliberate: the index finger itself never moved from
  // its resting, curled position. A genuine pinch always involves the index
  // reaching away from its own knuckle toward the thumb, so requiring that
  // reach — in addition to the raw thumb-index distance — keeps a plain
  // fist from being misread as PAN while still easily catching real
  // pinches, which move the index tip well clear of its knuckle.
  const indexReach = dist(landmarks[8], landmarks[5]) / scale;
  const reaching = indexReach > MIN_INDEX_REACH_FOR_PINCH;

  return { pinching: distance < threshold && reaching, distance };
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

// How far the thumb's direction (MCP -> tip) is allowed to lean away from
// straight up/down, in degrees, before it no longer counts as "up" or
// "down". This is what stops a thumb pointing mostly sideways (left/right)
// from ever being read as THUMBS_UP just because it's a little higher than
// its knuckle.
const THUMB_ANGLE_FROM_VERTICAL_DEG = 40;

// THUMBS_UP/DOWN needs a stricter bar than the general isThumbExtended()
// used elsewhere. isThumbExtended()'s lower bar (0.45) just means "unfolded
// from the fist a bit," which is also true mid-reach — e.g. a pinch attempt
// swings the thumb tip up and away from its own MCP toward the index finger,
// which is enough "length" to clear that lower bar even though the hand is
// still mid-pinch, not doing a deliberate thumbs-up. THUMBS_UP/DOWN is
// meant to be an unambiguous, deliberately exaggerated pose, so it needs the
// thumb pulled out much farther — close to its full extended length — before
// claiming the gesture, so a pinch- or count-in-progress can't be caught by
// isThumbPose() (checked first) before isPinch() or viewPose() get a look.
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

  // The thumb must be clearly, deliberately extended — a stricter bar than
  // isThumbExtended()'s, see MIN_THUMB_EXTENSION_RATIO_FOR_THUMB_POSE above.
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

// Matches the 4 main fingers + thumb against the VIEW_COUNTS table (see the
// big comment at the top of the file). Returns a view name ("front",
// "iso", ...) or null.
//
// Uses fingersExtended()'s [index, middle, ring, pinky, thumb] pattern
// as-is — including its thumb entry (see isThumbExtended()) — rather than
// recomputing thumb extension separately. Previously this recomputed the
// thumb boolean with its own distance-from-palm-center check, which used a
// much stricter bar than fingersExtended()'s (then-separate) thumb check;
// that mismatch is exactly what let an ordinary open-palm ROTATE gesture
// get misread as the "4"/RIGHT counting pose, since the thumb didn't have
// to be tucked in at all to fail the old, stricter distance check — see
// isThumbExtended()'s comment for the full story. Using a single shared
// thumb signal for both isOpenPalm() and viewPose() keeps them from
// disagreeing about the exact same hand shape.
export function viewPose(landmarks, label) {
  const pattern = fingersExtended(landmarks, label);
  for (const [name, expected] of Object.entries(VIEW_COUNTS)) {
    if (expected.every((v, i) => v === pattern[i])) return name;
  }
  return null;
}

export class GestureController {
  // panGain default of 125 (not some much smaller number) is deliberate:
  // cadViewer.js's pan()/rotate() apply PAN_UNIT=0.01 and ROTATE_UNIT=0.005
  // to these deltas, only 2x apart, so for a pinch-drag to feel as
  // responsive as ROTATE for the same hand movement, panGain needs to be
  // in the same ballpark as rotateGain (250) - roughly half of it, to
  // offset PAN_UNIT being 2x ROTATE_UNIT. A much smaller panGain (e.g. an
  // order of magnitude or more below rotateGain) makes PAN feel dead even
  // at max slider, since the pan speed slider's range is scaled to match.
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

      // 2. Pinch next: thumb-to-index distance, combined with the
      //    index-reach check inside isPinch() (the index tip must actually
      //    be reaching away from its own knuckle, toward the thumb — not
      //    just resting curled nearby), is checked before both the counting
      //    view poses and the fist test.
      //
      //    This matters most for the "OK sign" pinch shape (thumb and
      //    index tips touching to form a circle, other 3 fingers raised —
      //    see the isPinch() comment): with the 4 main fingers now read
      //    generically via fingersExtended(), that shape's boolean pattern
      //    ([index curled, middle/ring/pinky up, thumb tucked]) is
      //    identical to the "7"/ISO counting pose's pattern (see
      //    VIEW_COUNTS.iso). The two are only distinguishable by whether
      //    the thumb and index are actually touching/reaching for each
      //    other (a deliberate pinch) or just independently curled/tucked
      //    (a counting pose) — exactly what isPinch() checks. So pinch is
      //    checked first: a real OK-sign pinch always satisfies isPinch()
      //    and is claimed here, while a genuine "7" count (index resting
      //    curled, never reaching toward the thumb) fails isPinch()'s reach
      //    check and correctly falls through to the view-pose check below.
      const enterCheck = isPinch(lm, this.pinchThreshold);
      const distance = enterCheck.distance;
      result.pinchDistance = distance;

      // Hysteresis: while a pinch is already actively driving PAN, only
      // require the looser distance-only bar to stay classified as PAN
      // instead of re-passing isPinch()'s stricter entry check every
      // single frame. See PINCH_RELEASE_MULTIPLIER's comment for why.
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

      // 3. Counting view-snap poses next: an exact match against all 5
      //    finger booleans at once (see VIEW_COUNTS). Checked before the
      //    open-palm fallback further down since some counts (e.g. "4")
      //    are otherwise "almost open".
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