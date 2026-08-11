"""
gesture_controller.py
Turns raw hand landmarks (from hand_tracker.py) into pan / rotate / zoom
deltas that a 3D viewer can consume. Includes an exponential-moving-average
(EMA) filter so small hand tremors don't cause jittery model movement.

Gesture rules:
  - Two hands visible              -> ZOOM  (change in distance between palms)
  - One hand, thumb+index pinched  -> PAN   (drag the pinch point)
  - One hand, open palm            -> ROTATE (move the palm center)
  - Anything else                  -> IDLE  (no movement)
"""

import math


class EMA:
    """Simple exponential moving average filter for 1D smoothing."""

    def __init__(self, alpha=0.4):
        self.alpha = alpha
        self.value = None

    def update(self, new_value):
        if self.value is None:
            self.value = new_value
        else:
            self.value = self.alpha * new_value + (1 - self.alpha) * self.value
        return self.value

    def reset(self):
        self.value = None


class GestureState:
    IDLE = "IDLE"
    PAN = "PAN (pinch)"
    ROTATE = "ROTATE (open palm)"
    ZOOM = "ZOOM (two hands)"


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _hand_scale(landmarks):
    # Distance from wrist (0) to middle-finger MCP (9), used to normalize
    # the pinch distance so it works at any distance from the camera.
    return max(_dist(landmarks[0], landmarks[9]), 1e-6)


def _fingers_extended(landmarks, label):
    """Returns [index, middle, ring, pinky, thumb] booleans."""
    tips = [8, 12, 16, 20]
    pips = [6, 10, 14, 18]
    extended = [landmarks[tip][1] < landmarks[pip][1] for tip, pip in zip(tips, pips)]

    thumb_tip = landmarks[4]
    thumb_mcp = landmarks[2]
    if label == "Right":
        thumb_extended = thumb_tip[0] < thumb_mcp[0]
    else:
        thumb_extended = thumb_tip[0] > thumb_mcp[0]
    extended.append(thumb_extended)
    return extended


def is_open_palm(landmarks, label):
    return sum(_fingers_extended(landmarks, label)) >= 4


def is_pinch(landmarks, threshold=0.4):
    scale = _hand_scale(landmarks)
    d = _dist(landmarks[4], landmarks[8]) / scale
    return d < threshold, d


class GestureController:
    def __init__(self, pinch_threshold=0.4, pan_gain=2.5, rotate_gain=250.0, zoom_gain=8.0):
        self.pinch_threshold = pinch_threshold
        self.pan_gain = pan_gain
        self.rotate_gain = rotate_gain
        self.zoom_gain = zoom_gain

        self.pos_x_filter = EMA(0.4)
        self.pos_y_filter = EMA(0.4)
        self.two_hand_dist_filter = EMA(0.3)

        self._prev_pinch_pos = None
        self._prev_palm_pos = None
        self._prev_two_hand_dist = None
        self.state = GestureState.IDLE

    def _reset_single_hand(self):
        self._prev_pinch_pos = None
        self._prev_palm_pos = None
        self.pos_x_filter.reset()
        self.pos_y_filter.reset()

    def _reset_two_hand(self):
        self._prev_two_hand_dist = None
        self.two_hand_dist_filter.reset()

    def update(self, hands_data):
        """Returns {"state": str, "pan": (dx,dy)|None, "rotate": (dx,dy)|None, "zoom": float|None}"""
        result = {"state": GestureState.IDLE, "pan": None, "rotate": None, "zoom": None}

        if len(hands_data) == 2:
            c0 = hands_data[0]["landmarks"][9]
            c1 = hands_data[1]["landmarks"][9]
            smoothed = self.two_hand_dist_filter.update(_dist(c0, c1))
            if self._prev_two_hand_dist is not None:
                result["zoom"] = (smoothed - self._prev_two_hand_dist) * self.zoom_gain
            self._prev_two_hand_dist = smoothed
            result["state"] = GestureState.ZOOM
            self._reset_single_hand()
            self.state = result["state"]
            return result

        self._reset_two_hand()

        if len(hands_data) == 1:
            hand = hands_data[0]
            lm = hand["landmarks"]
            label = hand["label"]
            pinching, _ = is_pinch(lm, self.pinch_threshold)

            if pinching:
                self._prev_palm_pos = None
                mid_x = (lm[4][0] + lm[8][0]) / 2
                mid_y = (lm[4][1] + lm[8][1]) / 2
                sx = self.pos_x_filter.update(mid_x)
                sy = self.pos_y_filter.update(mid_y)
                if self._prev_pinch_pos is not None:
                    dx = (sx - self._prev_pinch_pos[0]) * self.pan_gain
                    dy = (sy - self._prev_pinch_pos[1]) * self.pan_gain
                    result["pan"] = (dx, dy)
                self._prev_pinch_pos = (sx, sy)
                result["state"] = GestureState.PAN

            elif is_open_palm(lm, label):
                self._prev_pinch_pos = None
                self.pos_x_filter.reset()
                self.pos_y_filter.reset()
                px, py = lm[9][0], lm[9][1]
                if self._prev_palm_pos is not None:
                    dx = (px - self._prev_palm_pos[0]) * self.rotate_gain
                    dy = (py - self._prev_palm_pos[1]) * self.rotate_gain
                    result["rotate"] = (dx, dy)
                self._prev_palm_pos = (px, py)
                result["state"] = GestureState.ROTATE
            else:
                self._reset_single_hand()
                result["state"] = GestureState.IDLE
        else:
            self._reset_single_hand()

        self.state = result["state"]
        return result