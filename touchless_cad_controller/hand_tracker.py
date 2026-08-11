"""
hand_tracker.py
Wraps MediaPipe's HandLandmarker (the current Tasks API) so the rest of the
app just gets a simple list of hands, each with 21 normalized (x, y, z)
landmarks and a Left/Right label.

Note: MediaPipe's older `mp.solutions.hands` API has been removed from
recent MediaPipe releases, so this uses the newer Tasks API instead. The
required model file (~10 MB) is downloaded automatically the first time
you run the app and cached next to this script.
"""

import os
import time
import urllib.request

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python import vision

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/latest/hand_landmarker.task"
)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")

# Hand skeleton connections (MediaPipe's 21-point hand model) for drawing.
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),          # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),          # index
    (5, 9), (9, 10), (10, 11), (11, 12),     # middle
    (9, 13), (13, 14), (14, 15), (15, 16),   # ring
    (13, 17), (17, 18), (18, 19), (19, 20),  # pinky
    (0, 17),                                 # palm base
]


def ensure_model():
    """Downloads the hand landmark model on first run, if it's not already cached."""
    if not os.path.exists(MODEL_PATH):
        print("Downloading hand-tracking model (one-time, ~10 MB)...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print(f"Model saved to {MODEL_PATH}")
    return MODEL_PATH


class HandTracker:
    def __init__(self, max_hands=2, detection_confidence=0.6, presence_confidence=0.6, tracking_confidence=0.6):
        model_path = ensure_model()
        base_options = BaseOptions(model_asset_path=model_path)
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.VIDEO,
            num_hands=max_hands,
            min_hand_detection_confidence=detection_confidence,
            min_hand_presence_confidence=presence_confidence,
            min_tracking_confidence=tracking_confidence,
        )
        self.landmarker = vision.HandLandmarker.create_from_options(options)
        self._last_timestamp_ms = 0

    def _next_timestamp_ms(self):
        # detect_for_video requires strictly increasing timestamps.
        ts = int(time.time() * 1000)
        if ts <= self._last_timestamp_ms:
            ts = self._last_timestamp_ms + 1
        self._last_timestamp_ms = ts
        return ts

    def process(self, frame_bgr):
        """Returns a list of dicts: {"landmarks": [(x,y,z), ...21], "label": "Left"/"Right"}"""
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self.landmarker.detect_for_video(mp_image, self._next_timestamp_ms())

        hands_data = []
        for landmarks, handedness in zip(result.hand_landmarks, result.handedness):
            points = [(lm.x, lm.y, lm.z) for lm in landmarks]
            label = handedness[0].category_name  # "Left" or "Right"
            hands_data.append({"landmarks": points, "label": label})
        return hands_data

    def draw(self, frame_bgr, hands_data):
        """Overlays the hand skeleton on the frame for on-screen debugging."""
        h, w = frame_bgr.shape[:2]
        for hand in hands_data:
            pts_px = [(int(x * w), int(y * h)) for x, y, _ in hand["landmarks"]]
            for a, b in HAND_CONNECTIONS:
                cv2.line(frame_bgr, pts_px[a], pts_px[b], (0, 200, 0), 2)
            for x, y in pts_px:
                cv2.circle(frame_bgr, (x, y), 4, (0, 140, 255), -1)
        return frame_bgr

    def close(self):
        self.landmarker.close()