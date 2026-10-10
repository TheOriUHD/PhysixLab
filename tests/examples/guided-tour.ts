// File: src/ui/extensions/inspector-tour.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerHint, registerTour } from '../../src/ui/tour';

// A tour: Help → "Take the tour: Meet the Inspector" (and the palette command `help.tour.inspector-basics`).
registerTour({
  id: 'inspector-basics',
  title: 'Meet the Inspector',
  steps: [
    // No target: a centred card.
    { target: null, title: 'The Inspector', body: 'Everything about the selected object is edited on the right.' },
    {
      target: '.panel.right', // a CSS selector, or a function returning the element
      title: 'Pick something',
      body: 'Click an object in the 3D view. Keys look like this: [[Shift]] + click adds to the selection.',
      placement: 'left',
      onEnter: (app) => app.prefs.set({ showRight: true, rightTab: 'inspector' }),
      waitFor: { event: 'selection' }, // moves on by itself when the user does it ("Skip step" stays available)
    },
    {
      target: '.tbtn.play',
      title: 'Now run it',
      body: 'Press **Simulate** and watch what the numbers do.',
      until: (app) => app.sim.mode === 'running', // or poll any condition you like
    },
  ],
});

// A context hint: shown once, the first time the user adds anything to the scene.
registerHint({
  id: 'demo-first-add',
  trigger: { event: 'scene-change', type: 'add' },
  text: 'Added! The Inspector on the right edits it — try the **Mass** field.',
});
