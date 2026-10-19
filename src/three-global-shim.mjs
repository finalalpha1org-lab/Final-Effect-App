// Build-time alias: the browser app already provides this exact Three.js release globally.
const T = globalThis.THREE;
if (!T) throw new Error('Three.js must load before the modifier CSG bundle');
export const BufferAttribute = T.BufferAttribute;
export const BufferGeometry = T.BufferGeometry;
export const Box3 = T.Box3;
export const Float32BufferAttribute = T.Float32BufferAttribute;
export const Material = T.Material;
export const MathUtils = T.MathUtils;
export const Matrix3 = T.Matrix3;
export const Matrix4 = T.Matrix4;
export const Mesh = T.Mesh;
export const MeshBasicMaterial = T.MeshBasicMaterial;
export const Triangle = T.Triangle;
export const Vector2 = T.Vector2;
export const Vector3 = T.Vector3;
