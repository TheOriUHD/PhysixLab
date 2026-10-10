/**
 * The three.js constructors handed to shape geometry factories (`ShapeDef.geometry`). The shape registry
 * lives in the document model and must not import three.js itself, so the renderer supplies this object.
 * When a new shape needs another constructor, add it here and to `GeometryKit` in `model/shapeRegistry.ts`.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type { GeometryKit } from '../model/shapeRegistry';

export const GEOMETRY_KIT: GeometryKit = {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  ConvexGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  SphereGeometry,
  Vector2,
  Vector3,
};
