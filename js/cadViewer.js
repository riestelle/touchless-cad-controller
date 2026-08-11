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
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = new THREE.Spherical(3, Math.PI / 2.3, Math.PI / 4);

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

  resetView() {
    if (this.currentObject) this._frameObject(this.currentObject);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
