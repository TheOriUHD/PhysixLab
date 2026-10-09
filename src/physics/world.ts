// The implementation lives in ./world/*; this file keeps `import … from './world'` working.
export { PhysicsWorld, initRapier } from './world/index';
export type { BodyRec, JointRec, SoftRec } from './world/index';
