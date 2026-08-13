// cadViewer.js
//
// Sets up the Three.js scene, camera, and lighting, and exposes pan/rotate/
// zoom methods that gesture deltas are fed into. Also handles loading a
// user-supplied STL/OBJ/PLY file, or building the default placeholder part.
//
// The camera orbits a target point using spherical coordinates (radius,
// theta, phi) — the same idea as Open3D's ViewControl used in the original
// Python version.

import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

// How strongly each gesture delta moves the camera. Raise these to make a
// gesture feel more sensitive, lower them to make it feel calmer.
const PAN_UNIT = 0.01;
const ROTATE_UNIT = 0.005;
const ZOOM_UNIT = 0.02;
const MIN_RADIUS = 0.5;
const MAX_RADIUS = 50;

// Named camera orientations, CAD-viewer style (front/top/iso, etc). Radius
// (zoom level) is deliberately left untouched by a snap — only the
// orientation changes, same as clicking a face on a "view cube."
const VIEW_PRESETS = {
  front: { theta: 0, phi: Math.PI / 2 },
  back: { theta: Math.PI, phi: Math.PI / 2 },
  right: { theta: Math.PI / 2, phi: Math.PI / 2 },
  left: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  top: { theta: 0, phi: 0.05 },
  bottom: { theta: 0, phi: Math.PI - 0.05 },
  iso: { theta: Math.PI / 4, phi: Math.PI / 2.3 },
};

function buildSamplePart() {
  // A simple bracket-like mesh so the demo works with zero downloads.
  const material = new THREE.MeshStandardMaterial({
    color: 0xa6b3d9,
    metalness: 0.15,
    roughness: 0.55,
  });

  const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.2, 0.8), material);
  base.position.set(0, -0.1, 0);

  const upright = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.0, 0.8), material);
  upright.position.set(-0.5, 0.4, 0);

  const group = new THREE.Group();
  group.add(base, upright);
  return group;
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xa6b3d9, metalness: 0.15, roughness: 0.55 });
}

export class CadViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11141c);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404060, 1.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(3, 5, 4);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-4, -2, -3);
    this.scene.add(fillLight);

    this.currentObject = null;
    this._panLimit = null; // set once an object is framed, see _frameObject()
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = new THREE.Spherical(3, Math.PI / 2.3, Math.PI / 4);
    // Home orientation, restored by resetView(). Captured once here (not
    // read back off `this.spherical` later) so it stays correct even
    // though spherical.theta/phi are mutated continuously by rotate().
    this._homeSpherical = { phi: this.spherical.phi, theta: this.spherical.theta };

    // Measurement tool state: up to 2 picked points, their marker meshes,
    // and the connecting line, all held in one group so clearing is a
    // single removal instead of tracking each mesh separately.
    this._raycaster = new THREE.Raycaster();
    this._measureGroup = new THREE.Group();
    this.scene.add(this._measureGroup);
    this._measurePoints = [];

    this._updateCameraPosition();
    this.resizeToContainer();
    window.addEventListener("resize", () => this.resizeToContainer());

    this.loadSamplePart();
  }

  resizeToContainer() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  _updateCameraPosition() {
    const offset = new THREE.Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  _replaceObject(object3D) {
    if (this.currentObject) this.scene.remove(this.currentObject);
    this.currentObject = object3D;
    this.scene.add(object3D);
    this._frameObject(object3D);
  }

  // Centers the object at the origin and picks a starting camera distance
  // that comfortably fits it in view, regardless of its native scale.
  _frameObject(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    object3D.position.sub(center);

    const fitRadius = Math.max(size.length() * 0.6, 0.5);
    this.target.set(0, 0, 0);
    this.spherical.radius = THREE.MathUtils.clamp(fitRadius * 2.2, MIN_RADIUS, MAX_RADIUS);

    // Cap how far a pinch-drag can carry the target from the model, so a
    // fast drag can't pan it clean off-screen.
    this._panLimit = fitRadius * 3;

    this._updateCameraPosition();
  }

  loadSamplePart() {
    this._replaceObject(buildSamplePart());
  }

  // Loads a model from a browser File object (from <input type="file">).
  // Supports .stl, .obj, and .ply.
  async loadFromFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    const buffer = await file.arrayBuffer();

    let object3D;
    if (ext === "stl") {
      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      object3D = new THREE.Mesh(geometry, defaultMaterial());
    } else if (ext === "ply") {
      const geometry = new PLYLoader().parse(buffer);
      geometry.computeVertexNormals();
      object3D = new THREE.Mesh(geometry, defaultMaterial());
    } else if (ext === "obj") {
      const text = new TextDecoder().decode(buffer);
      object3D = new OBJLoader().parse(text);
      object3D.traverse((child) => {
        if (child.isMesh) child.material = defaultMaterial();
      });
    } else {
      throw new Error(`Unsupported file type ".${ext}" — use .stl, .obj, or .ply`);
    }

    this._replaceObject(object3D);
  }

  pan(dx, dy) {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const offset = right
      .multiplyScalar(-dx * PAN_UNIT)
      .add(up.multiplyScalar(dy * PAN_UNIT));
    this.target.add(offset);
    if (this._panLimit) this.target.clampLength(0, this._panLimit);
    this._updateCameraPosition();
  }

  rotate(dx, dy) {
    this.spherical.theta -= dx * ROTATE_UNIT;
    this.spherical.phi = THREE.MathUtils.clamp(
      this.spherical.phi - dy * ROTATE_UNIT,
      0.05,
      Math.PI - 0.05
    );
    this._updateCameraPosition();
  }

  zoom(delta) {
    this.spherical.radius = THREE.MathUtils.clamp(
      this.spherical.radius - delta * ZOOM_UNIT,
      MIN_RADIUS,
      MAX_RADIUS
    );
    this._updateCameraPosition();
  }

  // Re-fits the camera to the object and restores the home orientation.
  resetView() {
    this.spherical.theta = this._homeSpherical.theta;
    this.spherical.phi = this._homeSpherical.phi;
    if (this.currentObject) {
      this._frameObject(this.currentObject);
    } else {
      this.target.set(0, 0, 0);
      this._updateCameraPosition();
    }
  }

  // Snaps the camera to a named orientation (front/back/left/right/top/
  // bottom/iso) without touching the current zoom level. Returns false for
  // an unknown name so callers can no-op safely.
  snapToView(name) {
    const preset = VIEW_PRESETS[name];
    if (!preset) return false;
    this.spherical.theta = preset.theta;
    this.spherical.phi = preset.phi;
    this._updateCameraPosition();
    return true;
  }

  setWireframe(enabled) {
    if (!this.currentObject) return;
    this.currentObject.traverse((child) => {
      if (child.isMesh && child.material) child.material.wireframe = enabled;
    });
  }

  // Casts a ray from normalized device coordinates (-1..1 on each axis)
  // through the current object and returns the first hit point, or null.
  pickPoint(ndcX, ndcY) {
    if (!this.currentObject) return null;
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this._raycaster.intersectObject(this.currentObject, true);
    return hits.length ? hits[0].point.clone() : null;
  }

  // Adds one measurement point from a raycast pick. Returns:
  //   { status: "miss" }                          — ray didn't hit the model
  //   { status: "first" }                          — first point placed, waiting for a second
  //   { status: "complete", distance, a, b }       — second point placed; distance is in the
  //                                                   model's own units (unknown real-world scale)
  addMeasurePoint(ndcX, ndcY) {
    const point = this.pickPoint(ndcX, ndcY);
    if (!point) return { status: "miss" };

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.015 * this.spherical.radius, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d })
    );
    marker.position.copy(point);
    this._measureGroup.add(marker);
    this._measurePoints.push(point);

    if (this._measurePoints.length < 2) {
      return { status: "first" };
    }

    const [a, b] = this._measurePoints;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0x33ff99 })
    );
    this._measureGroup.add(line);

    const distance = a.distanceTo(b);
    this._measurePoints = []; // ready for a fresh pair; markers stay visible until clearMeasurement()
    return { status: "complete", distance, a, b };
  }

  clearMeasurement() {
    for (const child of [...this._measureGroup.children]) {
      this._measureGroup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this._measurePoints = [];
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}