import * as THREE from "three";
import { matteMat } from "./engine";

export function addFloor(scene: THREE.Scene, size = 40, color = 0x0f172a) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), matteMat(color, 0.1));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  scene.add(new THREE.GridHelper(size, Math.max(8, Math.floor(size / 2)), 0x334155, 0x1e293b));
  return floor;
}

export function killMesh(scene: THREE.Scene, mesh: THREE.Object3D) {
  scene.remove(mesh);
  mesh.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Line)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

export function groundPick(camera: THREE.Camera, ndcX: number, ndcY: number, y = 0) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, hit)) hit.set(0, y, 0);
  return hit;
}

export function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    child.traverse((node) => {
      if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line) && !(node instanceof THREE.Points)) return;
      node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material.dispose());
    });
  }
}
