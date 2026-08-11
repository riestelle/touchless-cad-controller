"""
main.py
Touchless 3D CAD Model Navigation via Webcam Gesture Tracking.

Run:
    python main.py                     # uses a built-in sample bracket part
    python main.py --model part.stl    # loads your own .obj/.stl/.ply model
    python main.py --log session.csv   # also logs FPS + gesture state per frame

Controls:
    Pinch (thumb + index) and drag, one hand -> Pan
    Open palm, move, one hand                -> Rotate
    Two hands, change distance apart          -> Zoom
    'q' in the webcam window                  -> Quit
"""

import argparse
import csv
import time

import cv2
import numpy as np
import open3d as o3d

from hand_tracker import HandTracker
from gesture_controller import GestureController


def build_sample_part():
    """A simple bracket-like mesh so the demo runs with zero downloads."""
    base = o3d.geometry.TriangleMesh.create_box(width=1.2, height=0.2, depth=0.8)
    base.translate((-0.6, -0.1, -0.4))

    upright = o3d.geometry.TriangleMesh.create_box(width=0.2, height=1.0, depth=0.8)
    upright.translate((-0.6, -0.1, -0.4))

    mesh = base + upright
    mesh.compute_vertex_normals()
    mesh.paint_uniform_color([0.65, 0.7, 0.85])
    return mesh


def load_model(path):
    if path:
        mesh = o3d.io.read_triangle_mesh(path)
        mesh.compute_vertex_normals()
        if not mesh.has_vertex_colors():
            mesh.paint_uniform_color([0.65, 0.7, 0.85])
        return mesh
    return build_sample_part()


def main():
    parser = argparse.ArgumentParser(description="Touchless webcam gesture 3D CAD navigator")
    parser.add_argument("--model", type=str, default=None, help="Path to a .obj/.stl/.ply model (optional)")
    parser.add_argument("--camera", type=int, default=0, help="Webcam index (default 0)")
    parser.add_argument("--no-mirror", action="store_true", help="Disable mirroring the webcam feed")
    parser.add_argument("--log", type=str, default=None, help="CSV path to log FPS/gesture data for evaluation")
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"ERROR: could not open webcam index {args.camera}. Try a different --camera value.")
        return

    tracker = HandTracker(max_hands=2)
    controller = GestureController()
    mesh = load_model(args.model)

    vis = o3d.visualization.Visualizer()
    vis.create_window(window_name="Touchless CAD Viewer", width=1000, height=800)
    vis.add_geometry(mesh)
    view_control = vis.get_view_control()
    vis.get_render_option().mesh_show_back_face = True

    log_file = None
    log_writer = None
    if args.log:
        log_file = open(args.log, "w", newline="")
        log_writer = csv.writer(log_file)
        log_writer.writerow(["timestamp", "fps", "hands_detected", "state", "pan_dx", "pan_dy", "rotate_dx", "rotate_dy", "zoom"])

    print("Controls:")
    print("  Pinch (thumb+index) and move, one hand -> Pan")
    print("  Open palm, move, one hand              -> Rotate")
    print("  Two hands, change distance apart        -> Zoom")
    print("  Press 'q' in the webcam window to quit.")

    last_time = time.time()
    fps = 0.0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if not args.no_mirror:
                frame = cv2.flip(frame, 1)

            hands_data = tracker.process(frame)
            gesture = controller.update(hands_data)

            if gesture["pan"]:
                dx, dy = gesture["pan"]
                view_control.translate(-dx, dy, 0, 0)
            if gesture["rotate"]:
                dx, dy = gesture["rotate"]
                view_control.rotate(-dx, dy)
            if gesture["zoom"] is not None:
                view_control.scale(-gesture["zoom"])

            if not vis.poll_events():
                break
            vis.update_renderer()

            frame = tracker.draw(frame, hands_data)
            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - last_time, 1e-6))
            last_time = now

            cv2.putText(frame, f"Mode: {gesture['state']}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
            cv2.putText(frame, f"FPS: {fps:.1f}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
            cv2.putText(frame, f"Hands detected: {len(hands_data)}", (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
            cv2.imshow("Webcam - Hand Tracking", frame)

            if log_writer:
                pan = gesture["pan"] or (None, None)
                rot = gesture["rotate"] or (None, None)
                log_writer.writerow([now, f"{fps:.2f}", len(hands_data), gesture["state"], pan[0], pan[1], rot[0], rot[1], gesture["zoom"]])

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()
        tracker.close()
        vis.destroy_window()
        if log_file:
            log_file.close()


if __name__ == "__main__":
    main()