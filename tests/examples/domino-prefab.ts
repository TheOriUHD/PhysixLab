// File: src/model/content/domino-trio.ts
import { Builder } from '../../src/model/builder';
import { registerPrefab } from '../../src/model/content';

registerPrefab({
  id: 'domino-trio',
  name: 'Domino trio',
  icon: 'box',
  blurb: 'Three dominoes and a ball to start them.',
  build() {
    const b = new Builder('Domino trio');
    for (let i = 0; i < 3; i++) b.body('Domino', 'box', [0.14, 0.8, 0.45], [i * 0.38, 0.4, 0], { material: 'wood' });
    b.body('Ball', 'sphere', [0.4, 0.4, 0.4], [-1.2, 0.2, 0], { material: 'steel', velocity: [3, 0, 0] });
    return b.doc.entities;
  },
});
