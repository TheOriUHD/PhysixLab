/**
 * Palette icons of the package-SH shapes as inline SVG bodies (24×24, stroked with `currentColor` by the icon
 * wrapper in `src/ui/icons.ts`, which accepts any string starting with `<` as an icon). They live next to the
 * shapes so a new shape is one file plus one line in `shapes/index.ts` and `ui/icons.ts` stays untouched.
 */
export const SHAPE_ICONS = {
  torus:
    '<ellipse cx="12" cy="12.5" rx="9.5" ry="6.5"/><path d="M7.4 12.2c1.3-1.7 2.8-2.4 4.6-2.4s3.3.7 4.6 2.4"/><path d="M8.4 12.6c1 1 2.2 1.5 3.6 1.5s2.6-.5 3.6-1.5" opacity=".0"/>',
  ring: '<ellipse cx="12" cy="10" rx="9.5" ry="5.5"/><ellipse cx="12" cy="10" rx="4.6" ry="2.4"/><path d="M2.5 10v3.5c0 3 4.3 5.5 9.5 5.5s9.5-2.5 9.5-5.5V10"/>',
  tube: '<ellipse cx="12" cy="6" rx="7" ry="3"/><ellipse cx="12" cy="6" rx="3.9" ry="1.5"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  arch: '<path d="M3 20V5h18v15h-5.5v-6.5a3.5 3.5 0 0 0-7 0V20z"/><path d="M3 9h5M16 9h5" opacity=".55"/>',
  stairs: '<path d="M3 20v-4.5h4.5V11H12V6.5h4.5V4H21v16z"/><path d="M7.5 15.5h4.5M12 11h4.5" opacity=".55"/>',
  'spiral-stairs':
    '<path d="M12 3v18"/><path d="M12 19.5l7-1.7v2.2zM12 15.5l-7-1.7v2.2zM12 11.5l7-1.7v2.2zM12 7.5L5 5.8V8z"/>',
  hemisphere:
    '<path d="M3 14a9 9 0 0 1 18 0z"/><path d="M3 14c0 2.2 4 4 9 4s9-1.8 9-4"/><path d="M7 9.5a6 6 0 0 1 3-2" opacity=".6"/>',
  dome: '<path d="M3 17c0-5.5 4-9.5 9-9.5s9 4 9 9.5z"/><path d="M3 17c0 1.8 4 3 9 3s9-1.2 9-3"/><path d="M7 12.5a6 6 0 0 1 3-2.6" opacity=".6"/>',
  frustum:
    '<path d="M8.2 5.5h7.6l4.4 12c0 1.9-3.9 3.5-8.2 3.5S3.8 19.4 3.8 17.5z"/><ellipse cx="12" cy="5.5" rx="3.8" ry="1.5"/>',
  'i-beam': '<path d="M4 4.5h16v3.8h-6.1v7.4H20v3.8H4v-3.8h6.1V8.3H4z"/>',
  'l-beam': '<path d="M5 4h5.2v11.2H19V20H5z"/><path d="M10.2 15.2H5" opacity=".55"/>',
  't-beam': '<path d="M3 5h18v4.4h-6.4V20H9.4V9.4H3z"/>',
} as const;
