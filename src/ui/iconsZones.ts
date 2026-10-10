/** Icons of the zones package (ZN): one per zone action, plus the Race panel and the world bounds. */
export const ZONE_ICONS: Record<string, string> = {
  zone: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" stroke-dasharray="3.2 2.6"/><circle cx="12" cy="12" r="2"/>',
  checkpoint: '<path d="M5 21V5M19 21V5M5 5h14"/><path d="M9 14l2.2 2.2L15.5 12"/>',
  startLine: '<path d="M5 4v16"/><path d="M10 8l4 4-4 4M15 8l4 4-4 4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h14l-3 4.5 3 4.5H5"/><path d="M9 4v9M13 4v9" opacity=".55"/>',
  skull:
    '<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><path d="M10.5 20v-2M13.5 20v-2"/>',
  respawn:
    '<path d="M20 12a8 8 0 1 1-2.8-6.1"/><path d="M20 4v5h-5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  teleport:
    '<ellipse cx="6" cy="12" rx="3" ry="6.5"/><ellipse cx="18" cy="12" rx="3" ry="6.5"/><path d="M9.5 12h5M12.7 9.4L15 12l-2.3 2.6"/>',
  launch: '<path d="M12 17V4M7 9l5-5 5 5"/><path d="M5 21h14M8 17h8"/>',
  gravity: '<circle cx="12" cy="5.5" r="2.5"/><path d="M12 10.5V20M8 16l4 4 4-4"/>',
  forceField:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  spawn: '<rect x="4" y="9" width="11" height="11" rx="2"/><path d="M18 3v6M15 6h6"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
  score: '<path d="M12 3l2.7 5.5 6 .9-4.4 4.2 1 6L12 16.8 6.7 19.6l1-6L3.3 9.4l6-.9z"/>',
  toggle: '<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2.4" fill="currentColor"/>',
  event:
    '<circle cx="12" cy="12" r="2"/><path d="M7.5 7.5a6 6 0 0 0 0 9M16.5 7.5a6 6 0 0 1 0 9M4.6 4.6a10 10 0 0 0 0 14.8M19.4 4.6a10 10 0 0 1 0 14.8"/>',
  stopwatch: '<circle cx="12" cy="14" r="7"/><path d="M12 14v-4M9.5 3h5M12 3v4M18.5 6.5l1.5-1.5"/>',
  bounds: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="2.5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 21h8M9.5 17h5"/>',
};
