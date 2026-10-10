/**
 * Palette icons of the package-SH shapes as inline SVG bodies (24×24, stroked with `currentColor` by the icon
 * wrapper in `src/ui/icons.ts`, which accepts any string starting with `<` as an icon). They live next to the
 * shapes so a new shape is one file plus one line in `shapes/index.ts` and `ui/icons.ts` stays untouched.
 */
export const SHAPE_ICONS = {
  torus: '<ellipse cx="12" cy="12" rx="9.5" ry="6.5"/><ellipse cx="12" cy="11.4" rx="4" ry="1.9"/>',
  ring: '<ellipse cx="12" cy="10" rx="9.5" ry="5.5"/><ellipse cx="12" cy="10" rx="4.6" ry="2.4"/><path d="M2.5 10v3.5c0 3 4.3 5.5 9.5 5.5s9.5-2.5 9.5-5.5V10"/>',
  tube: '<ellipse cx="12" cy="6" rx="7" ry="3"/><ellipse cx="12" cy="6" rx="3.9" ry="1.5"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  arch: '<path d="M3 20V5h18v15h-5.5v-6.5a3.5 3.5 0 0 0-7 0V20z"/><path d="M3 9h5M16 9h5" opacity=".55"/>',
  stairs: '<path d="M3 20v-4.5h4.5V11H12V6.5h4.5V4H21v16z"/><path d="M7.5 15.5h4.5M12 11h4.5" opacity=".55"/>',
  'spiral-stairs':
    '<path d="M12 3v18"/><path d="M12 19.5l7-2M12 15.5l-7-2M12 11.5l7-2M12 7.5L5 5.5"/><path d="M12 21l7-2M12 17l-7-2M12 13l7-2M12 9L5 7" opacity=".5"/>',
  hemisphere:
    '<path d="M3 14a9 9 0 0 1 18 0z"/><path d="M3 14c0 2.2 4 4 9 4s9-1.8 9-4"/><path d="M7 9.5a6 6 0 0 1 3-2" opacity=".6"/>',
  dome: '<path d="M3 17c0-5.5 4-9.5 9-9.5s9 4 9 9.5z"/><path d="M3 17c0 1.8 4 3 9 3s9-1.2 9-3"/><path d="M7 12.5a6 6 0 0 1 3-2.6" opacity=".6"/>',
  frustum:
    '<path d="M8.2 5.5h7.6l4.4 12c0 1.9-3.9 3.5-8.2 3.5S3.8 19.4 3.8 17.5z"/><ellipse cx="12" cy="5.5" rx="3.8" ry="1.5"/>',
  ellipsoid: '<ellipse cx="12" cy="12" rx="9.5" ry="6.4"/><path d="M5.6 9.6c1.5-1.5 3.6-2.3 6.4-2.3" opacity=".55"/>',
  pyramid: '<path d="M12 3.5 3.5 17.5l8.5 3 8.5-3z"/><path d="M12 3.5v17M3.5 17.5l8.5 3" opacity=".55"/>',
  tetrahedron: '<path d="M12 3.5 3.5 18l9 2.5 8-4.8z"/><path d="M12 3.5l.5 17M3.5 18l17-2.3" opacity=".55"/>',
  octahedron: '<path d="M12 2.5 3.5 12l8.5 9.5 8.5-9.5z"/><path d="M3.5 12h17M12 2.5v19" opacity=".55"/>',
  dodecahedron:
    '<path d="m12 3 7.6 5.5-2.9 8.9H7.3L4.4 8.5z"/><path d="m12 8.4 3.3 2.4-1.3 3.9h-4l-1.3-3.9z" opacity=".7"/><path d="M12 3v5.4M19.6 8.5l-4.3 2.3M16.7 17.4 14 14.7M7.3 17.4 10 14.7M4.4 8.5l4.3 2.3" opacity=".55"/>',
  gear: '<path d="M19.39 10.23 L21.91 10.67 L21.91 13.33 L19.39 13.77 L18.48 15.97 L19.95 18.07 L18.07 19.95 L15.97 18.48 L13.77 19.39 L13.33 21.91 L10.67 21.91 L10.23 19.39 L8.03 18.48 L5.93 19.95 L4.05 18.07 L5.52 15.97 L4.61 13.77 L2.09 13.33 L2.09 10.67 L4.61 10.23 L5.52 8.03 L4.05 5.93 L5.93 4.05 L8.03 5.52 L10.23 4.61 L10.67 2.09 L13.33 2.09 L13.77 4.61 L15.97 5.52 L18.07 4.05 L19.95 5.93 L18.48 8.03Z"/><circle cx="12" cy="12" r="3"/>',
  wheel:
    '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="6.3"/><circle cx="12" cy="12" r="1.8"/><path d="M12 5.7v4.5M12 13.8v4.5M5.7 12h4.5M13.8 12h4.5" opacity=".7"/>',
  d4: '<path d="M12 3.5 21 19.5H3z"/><path d="M12 3.5v10.5M12 14 3 19.5M12 14l9 5.5" opacity=".55"/>',
  d6: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.6"/><circle cx="8.2" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="1.15" fill="currentColor" stroke="none"/>',
  d8: '<path d="M12 2.5 3.5 12l8.5 9.5 8.5-9.5z"/><path d="M12 8.2 8 12h8z" opacity=".7"/><path d="M12 2.5v5.7M3.5 12 8 12M20.5 12H16M12 21.5V12" opacity=".5"/>',
  d10: '<path d="M12 2.5 20 10l-8 11.5L4 10z"/><path d="M12 2.5v19M4 10h16M12 2.5l4 7.5M12 2.5 8 10" opacity=".5"/>',
  d12: '<path d="m12 2.8 7.8 5.7-3 9.2H7.2l-3-9.2z"/><path d="m12 8.3 3.4 2.5-1.3 4h-4.2l-1.3-4z" opacity=".7"/><path d="M12 2.8v5.5M19.8 8.5l-4.4 2.3M16.8 17.7 14.1 14.8M7.2 17.7l2.7-2.9M4.2 8.5l4.4 2.3" opacity=".5"/>',
  d20: '<path d="m12 2.6 8.3 4.8v9.2L12 21.4l-8.3-4.8V7.4z"/><path d="m12 7.6 4.4 8H7.6z" opacity=".75"/><path d="M12 2.6v5M20.3 7.4l-3.9 2.6M3.7 7.4l3.9 2.6M12 21.4v-5.6M3.7 16.6l3.9-1.2M20.3 16.6l-3.9-1.2" opacity=".5"/>',
  'curved-ramp': '<path d="M3 19.5h18V5.5c-2.2 8.6-8.2 14-18 14z"/><path d="M3 19.5c7 0 12.2-4 15.6-10" opacity=".5"/>',
  'quarter-pipe': '<path d="M3 20h18V4c0 9.5-8 16-18 16z"/><path d="M21 4v16" opacity=".55"/>',
  'half-pipe': '<path d="M3 4h18v16H3z"/><path d="M3 4c0 8.6 4 12.5 9 12.5S21 12.6 21 4" fill="none"/>',
  'rounded-box':
    '<rect x="3.5" y="3.5" width="17" height="17" rx="6"/><path d="M7.5 9.2c.5-1.2 1.4-2 2.7-2.4" opacity=".6"/>',
  'rounded-cylinder':
    '<path d="M5 8.2c0-2.4 3-4.2 7-4.2s7 1.8 7 4.2v7.6c0 2.4-3 4.2-7 4.2s-7-1.8-7-4.2z"/><path d="M5 8.4c0 2.2 3.1 3.6 7 3.6s7-1.4 7-3.6" opacity=".6"/>',
  'i-beam': '<path d="M4 4.5h16v3.8h-6.1v7.4H20v3.8H4v-3.8h6.1V8.3H4z"/>',
  'l-beam': '<path d="M5 4h5.2v11.2H19V20H5z"/><path d="M10.2 15.2H5" opacity=".55"/>',
  't-beam': '<path d="M3 5h18v4.4h-6.4V20H9.4V9.4H3z"/>',
} as const;
