/* FEIcons - one inline SVG set for the whole app.

   Emoji were never meant to be product icons: they render differently on every
   OS, cannot inherit the accent colour and look out of place next to real
   type. This module owns a single 24x24 stroke set, renders it inline (so it
   inherits currentColor) and replaces any emoji that still reaches the DOM -
   static markup, template strings from the terrain page and toasts alike.

   API:
     FEIcons.svg(name, {size, className})  -> markup string
     FEIcons.hydrate(root)                 -> fill <i data-ico>, swap text emoji
     FEIcons.start()                       -> hydrate now + watch for new nodes
*/
(function (global) {
  'use strict';

  /* Every icon is a set of stroke paths on a 24x24 grid. Keeping the geometry
     normalised means one CSS rule can size them all. */
  const PATHS = {
    cube: '<path d="M12 2.6 21 7v10l-9 4.4L3 17V7z"/><path d="M3 7l9 4.4L21 7M12 11.4V21"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    landscape: '<path d="M3 19h18"/><path d="M4 19l5.5-8 3.6 5 2.4-3.3L20 19"/><circle cx="8" cy="7" r="2"/>',
    bolt: '<path d="M13 2 4.5 13.5H11L9.6 22 19 10.2h-6.4z"/>',
    skull: '<path d="M12 2.8c-4.4 0-7.4 3-7.4 7v3.3c0 1.4.7 2.3 1.7 2.9v3.2c0 1 .8 1.8 1.8 1.8h7.8c1 0 1.8-.8 1.8-1.8V16c1-.6 1.7-1.5 1.7-2.9V9.8c0-4-3-7-7.4-7z"/><circle cx="9" cy="10.5" r="1.4"/><circle cx="15" cy="10.5" r="1.4"/><path d="M10.5 15h3"/>',
    masks: '<path d="M4 6c2.6-1.2 5.4-1.2 8 0v5a4 4 0 0 1-8 0z"/><path d="M20 8c-2.6-1.2-5.4-1.2-8 0v5a4 4 0 0 0 8 0z"/><path d="M6.5 8.5h.01M9.5 8.5h.01M14.5 11h.01M17.5 11h.01"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5 16 11l-6 6"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.4h7A2.5 2.5 0 0 1 21 10v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.6a4 4 0 0 1 8 0V10"/>',
    unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.6a4 4 0 0 1 7.4-2"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4 15H3.9a2 2 0 0 1 0-4H4a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 4.3V3.9a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.9 11h.2a2 2 0 0 1 0 4z"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4.8c0-.5.4-.8.8-.8h4.4c.4 0 .8.3.8.8V7M6.5 7l.8 12.2c0 .5.4.8.8.8h7.8c.4 0 .8-.3.8-.8L18.5 7"/><path d="M10 11v6M14 11v6"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-13.7-5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5L20 16"/><path d="M20 20v-4h-4"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 0 14"/>',
    redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12h-9a7 7 0 0 0 0 14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.1 3.8"/><path d="M6.4 7.9A16.8 16.8 0 0 0 2.5 12S6 18 12 18a9.4 9.4 0 0 0 4-.9"/>',
    play: '<path d="M7 4.5 19 12 7 19.5z"/>',
    pause: '<path d="M8 4.5v15M16 4.5v15"/>',
    record: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.2"/>',
    video: '<rect x="3" y="6" width="12" height="12" rx="2.4"/><path d="M15 10.5 21 7v10l-6-3.5z"/>',
    camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-2h6.9l1.2 2h1.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5 19.4 18l2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z"/>',
    globe: '<circle cx="12" cy="12" r="8.7"/><path d="M3.3 12h17.4M12 3.3c2.4 2.3 3.6 5.4 3.6 8.7s-1.2 6.4-3.6 8.7c-2.4-2.3-3.6-5.4-3.6-8.7S9.6 5.6 12 3.3z"/>',
    map: '<path d="M9 4 3.5 6.4v14L9 18l6 2.4 5.5-2.4v-14L15 6.4z"/><path d="M9 4v14M15 6.4V20.4"/>',
    mountain: '<path d="M2.5 19.5 9 8l3.7 6.2L15 11l6.5 8.5z"/><path d="M7.4 11.2 9 8l1.5 2.5"/>',
    tree: '<path d="M12 3 6.5 11h3L6 16.5h12L14.5 11h3z"/><path d="M12 16.5V21"/>',
    palms: '<path d="M12 21c0-5 .4-8 2.5-10.5"/><path d="M14.5 10.5C17 8 20 9 21 11c-2 .4-4 .4-6.5-.5zM14.5 10.5C12 8 9.5 8.5 8 10.5c2 .7 4 .7 6.5 0zM14.5 10.5C13 7 14 4.5 16 4c.4 2 .2 4-1.5 6.5z"/>',
    leaf: '<path d="M20 4c-8 0-14 4.5-14 11a5 5 0 0 0 5 5c6.5 0 9-6 9-16z"/><path d="M4 21c2-5 5.5-9 12-12"/>',
    sprout: '<path d="M12 21v-8"/><path d="M12 13C9 13 6.5 11 6 7.5c3.3-.4 5.5 1.4 6 5.5z"/><path d="M12 11c.6-4 3-6 6.5-5.6C18 9 15.4 11 12 11z"/>',
    flower: '<circle cx="12" cy="9" r="2.4"/><path d="M12 6.6C12 4.2 10.5 3 9 3.4c-.2 2 .7 3.4 3 3.2zM12 6.6c0-2.4 1.5-3.6 3-3.2.2 2-.7 3.4-3 3.2zM9.7 10.4c-2.2 1-3.8.3-4.4-1 1.4-1.4 3-1.4 4.4 1zM14.3 10.4c2.2 1 3.8.3 4.4-1-1.4-1.4-3-1.4-4.4 1z"/><path d="M12 11.4V21"/>',
    cactus: '<path d="M9.5 21V8.5a2.5 2.5 0 0 1 5 0V21"/><path d="M9.5 15H7a2 2 0 0 1-2-2v-3M14.5 12H17a2 2 0 0 0 2-2V7"/>',
    rock: '<path d="M4 18.5 7 8l5-3.5L17 7l3 11.5z"/><path d="M9.5 6.5 11 12l-4 6.5M11 12l6 6.5"/>',
    volcano: '<path d="M2.5 20 9 9l3 3 3-3 6.5 11z"/><path d="M9 9c0-2 1-3.5 3-5 2 1.5 3 3 3 5"/><path d="M12 2.5v2"/>',
    water: '<path d="M2.5 7.5c2.5-2 5-2 7.5 0s5 2 7.5 0 4-1.4 4-1.4"/><path d="M2.5 12.5c2.5-2 5-2 7.5 0s5 2 7.5 0 4-1.4 4-1.4"/><path d="M2.5 17.5c2.5-2 5-2 7.5 0s5 2 7.5 0 4-1.4 4-1.4"/>',
    droplet: '<path d="M12 3s6 6.4 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3 12 3z"/>',
    snow: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M20.2 7.2 3.8 16.8"/><path d="M12 6.2 9.6 4.2M12 6.2l2.4-2M12 17.8l-2.4 2M12 17.8l2.4 2"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"/>',
    moon: '<path d="M20 14.5A8.7 8.7 0 0 1 9.5 4a8.7 8.7 0 1 0 10.5 10.5z"/>',
    sunrise: '<path d="M3 18h18"/><path d="M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M12 5v3M4.6 8.6 6 10M19.4 8.6 18 10"/>',
    sunset: '<path d="M3 18h18"/><path d="M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M12 2.5v3.2M4.6 9 6 10.4M19.4 9 18 10.4M9.5 5.5 12 8l2.5-2.5"/>',
    city: '<path d="M3 21V8l5-2.5V21"/><path d="M8 21V6l6-3v18"/><path d="M14 21V10l7 3v8"/><path d="M5.5 10.5h.01M5.5 14h.01M11 9h.01M11 13h.01M17 15h.01"/>',
    planet: '<circle cx="12" cy="12" r="6.4"/><ellipse cx="12" cy="12" rx="10" ry="3.4" transform="rotate(-24 12 12)"/>',
    rocket: '<path d="M12 2.8c3 2 4.6 5.3 4.6 9.2 0 2.6-1 4.6-1.8 5.7H9.2c-.8-1.1-1.8-3.1-1.8-5.7 0-3.9 1.6-7.2 4.6-9.2z"/><path d="M9.2 15.5 6.8 19h3.1M14.8 15.5 17.2 19h-3.1"/><circle cx="12" cy="9.4" r="1.7"/>',
    flame: '<path d="M12 2.8c3.4 3.4 5.4 6.4 5.4 9.4a5.4 5.4 0 0 1-10.8 0c0-1.3.4-2.6 1.2-3.8.3 1.2.9 2 1.8 2.5.6-3 .6-6 2.4-8.1z"/>',
    smoke: '<path d="M6 18h8a4 4 0 0 0 .6-8 5 5 0 0 0-9.3 1.6A3.2 3.2 0 0 0 6 18z"/><path d="M17 5.5c1.4.3 2.4 1.4 2.7 2.8M19.5 11.5c1 .5 1.7 1.4 1.9 2.5"/>',
    fire: '<path d="M12 2.8c3.4 3.4 5.4 6.4 5.4 9.4a5.4 5.4 0 0 1-10.8 0c0-1.3.4-2.6 1.2-3.8.3 1.2.9 2 1.8 2.5.6-3 .6-6 2.4-8.1z"/><path d="M12 21v-3"/>',
    cloud: '<path d="M6.5 18.5h11a3.8 3.8 0 0 0 .5-7.6 5.6 5.6 0 0 0-10.7 1 3.4 3.4 0 0 0-.8 6.6z"/>',
    wind: '<path d="M3 8.5h9a2.5 2.5 0 1 0-2.5-2.5M3 12.5h13a2.5 2.5 0 1 1-2.5 2.5M3 16.5h6"/>',
    wave: '<path d="M2.5 9c2.5-2.6 5-2.6 7.5 0s5 2.6 7.5 0 4-1.8 4-1.8"/><path d="M2.5 15c2.5-2.6 5-2.6 7.5 0s5 2.6 7.5 0 4-1.8 4-1.8"/>',
    droplets: '<path d="M8 3.5s3.4 3.8 3.4 6.2a3.4 3.4 0 0 1-6.8 0C4.6 7.3 8 3.5 8 3.5z"/><path d="M16.5 10s3 3.4 3 5.6a3 3 0 0 1-6 0c0-2.2 3-5.6 3-5.6z"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 12.5 12 17.5l9-5"/><path d="M3 16.5 12 21.5l9-5"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    wand: '<path d="M4 20 16 8"/><path d="M14 3.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/><path d="M19 12l.7 1.8 1.8.7-1.8.7L19 17l-.7-1.8-1.8-.7 1.8-.7z"/>',
    pen: '<path d="M4 20l.8-4.2L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.2 19.2z"/><path d="M13.8 6.8l3.4 3.4"/>',
    brush: '<path d="M4.5 19.5c0-2 1-3.5 3-3.5 1.7 0 3 1.3 3 3 0 2-1.5 2.5-3 2.5-1.7 0-3-.5-3-2z"/><path d="M9.5 15.5 18 5.2a1.8 1.8 0 0 1 2.7 2.3L11 16.7"/>',
    eraser: '<path d="M8 20h11"/><path d="M15.5 4.5 4.5 15.5a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0l11-11a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0z"/><path d="M9 9.5l5.5 5.5"/>',
    ruler: '<rect x="2.5" y="8" width="19" height="8" rx="2" transform="rotate(-12 12 12)"/><path d="M7 10.2v2M11 9.4v3M15 8.6v2M19 7.8v3"/>',
    cube3d: '<path d="M12 2.6 21 7v10l-9 4.4L3 17V7z"/><path d="M3 7l9 4.4L21 7M12 11.4V21"/><path d="M7.5 4.8v5.2M16.5 4.8v5.2"/>',
    stack: '<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="M3 12 12 16.5 21 12"/><path d="M3 16.5 12 21l9-4.5"/>',
    pin: '<path d="M12 21s6.5-6.2 6.5-10.6a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.4"/>',
    rulerSet: '<path d="M3 21h18"/><path d="M6 21V7l4-3 4 3v14"/><path d="M10 9h.01M10 13h.01"/>',
    save: '<path d="M5 3.5h11L20.5 8v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 20V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v6h8v-6M8 21v-6h8v6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.6h3"/>',
    desktop: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 21h7M12 16.5V21"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
    gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 13.5 16 9"/><circle cx="12" cy="13.5" r="1.4" fill="currentColor" stroke="none"/>',
    activity: '<path d="M2.5 12h4l2.5-6.5L13 18l2.5-6H21.5"/>',
    flask: '<path d="M9 3h6M10 3v6.2L5.2 17a2.4 2.4 0 0 0 2 3.5h9.6a2.4 2.4 0 0 0 2-3.5L14 9.2V3"/><path d="M7.5 15h9"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3.2"/><circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/>',
    hash: '<path d="M9 3.5 7.5 20.5M16.5 3.5 15 20.5M4 8.5h16M3.5 15.5h16"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6"/>',
    bell: '<path d="M18 15.5V10a6 6 0 0 0-12 0v5.5L4.5 18h15z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/>',
    info: '<circle cx="12" cy="12" r="8.7"/><path d="M12 11v5.5M12 7.8h.01"/>',
    warning: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 9v5M12 17.2h.01"/>',
    clock: '<circle cx="12" cy="12" r="8.7"/><path d="M12 7v5.4l3.5 2"/>',
    help: '<circle cx="12" cy="12" r="8.7"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4M12 17.2h.01"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    chevronDown: '<path d="M6 9.5 12 15l6-5.5"/>',
    chevronRight: '<path d="M9.5 6 15 12l-5.5 6"/>',
    arrowRight: '<path d="M4 12h15M13.5 6l6 6-6 6"/>',
    arrowUp: '<path d="M12 20V5M6 11.5l6-6 6 6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    dot: '<circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/>',
    dots: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    box: '<path d="M3.5 7.5 12 3l8.5 4.5V17L12 21.5 3.5 17z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9.5"/>',
    shape: '<circle cx="8" cy="8" r="4.2"/><rect x="11.5" y="11.5" width="9" height="9" rx="1.6"/>',
    vector: '<path d="M5 19 19 5"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="5" r="2.2"/><path d="M13 5h6v6"/>',
    nodes: '<circle cx="5" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="12" r="2.2"/><path d="M7.2 6.8 16.8 11M7.2 17.2 16.8 13"/>',
    code: '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2.4"/><rect x="9" y="9" width="6" height="6" rx="1.2"/><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5"/>',
    shield: '<path d="M12 2.8 20 6v6c0 5-3.4 8.2-8 9.2-4.6-1-8-4.2-8-9.2V6z"/><path d="M8.8 12.2 11 14.4l4.4-4.6"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
    orb: '<circle cx="12" cy="12" r="7.2"/><path d="M12 4.8c3 2 4.5 4.4 4.5 7.2s-1.5 5.2-4.5 7.2c-3-2-4.5-4.4-4.5-7.2S9 6.8 12 4.8z"/><path d="M5.2 9.4h13.6"/>',
    torus: '<ellipse cx="12" cy="12" rx="8.4" ry="6"/><ellipse cx="12" cy="12" rx="3.4" ry="2.2"/>',
    sphere: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 9.4c5.6 2.4 11.2 2.4 16.8 0M12 3.4c-2 5.4-2 11.8 0 17.2"/>',
    cylinder: '<ellipse cx="12" cy="6.6" rx="6.6" ry="2.7"/><path d="M5.4 6.6V17.7c0 1.5 2.96 2.7 6.6 2.7s6.6-1.2 6.6-2.7V6.6"/>',
    cone: '<path d="M12 3.4 4.4 18.5"/><path d="M12 3.4 19.6 18.5"/><ellipse cx="12" cy="18.5" rx="7.6" ry="2.6"/>',
    plane: '<path d="M3.6 16.5 9.9 5.2l10.5 2.5-6.3 11.2z"/>',
    bulb: '<path d="M9.3 17.2v-1.4a5.9 5.9 0 1 1 5.4 0v1.4z"/><path d="M9.7 20.2h4.6"/>',
    broom: '<path d="M14.5 3.5 10 8"/><path d="M7.4 7.4 16.6 16.6"/><path d="M6.2 10.6 3.4 20.6l10-2.8z"/>',
    heart: '<path d="M12 20.4S3.6 15 3.6 9.4A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.4 2.8c0 5.6-8.4 11-8.4 11z"/>',
    skipBack: '<path d="M18.5 5.5v13L8.5 12z"/><path d="M5 5.5v13"/>',
    skipForward: '<path d="M5.5 5.5v13L15.5 12z"/><path d="M19 5.5v13"/>',
    ban: '<circle cx="12" cy="12" r="8.6"/><path d="M6.2 6.2 17.8 17.8"/>',
    grass: '<path d="M4.5 20c0-4.6 1.4-8 4.2-10.4M9 20c-.4-3.6.4-6.6 2.6-9M13.6 20c.4-4 2-6.8 4.8-8.4"/><path d="M3.5 20h17"/>',
    log: '<ellipse cx="7.4" cy="9.6" rx="3.4" ry="4.6"/><path d="M7.4 5v9.2M10.8 7.2h7a2.6 2.6 0 0 1 0 5.2h-7"/><path d="M10.8 12.4h6"/>',
    hole: '<ellipse cx="12" cy="12" rx="8" ry="5.2"/><ellipse cx="12" cy="12" rx="4" ry="2.4"/>',
    dunes: '<path d="M2.5 19.5c4-5.6 7.6-6.6 11-2.4 2.4 3 4.8 3.2 8 .4"/><path d="M14.5 6.2a4.2 4.2 0 0 1 0 8.4"/>',
    fog: '<path d="M3.5 9.5h10.2a3 3 0 1 0-2.8-4.2"/><path d="M3.5 13.5h13.4"/><path d="M3.5 17.5h9.6"/>',
    rain: '<path d="M6.8 14.5h10.6a3.4 3.4 0 0 0 .4-6.8 5.2 5.2 0 0 0-9.9.9 3 3 0 0 0-1.1 5.9z"/><path d="M8.5 17.5 7.5 21M12.5 17.5 11.5 21M16.5 17.5 15.5 21"/>',
    tornado: '<path d="M3.5 5.5h17"/><path d="M5.5 9h13"/><path d="M7.5 12.5h9"/><path d="M9.5 16h5"/><path d="M11.5 19.5h1.6"/>',
    galaxy: '<path d="M12 4.2c4 0 7.2 2.4 7.2 5.4 0 2.6-2.6 4.6-5.8 4.6-2.6 0-4.6-1.4-4.6-3.2 0-1.5 1.4-2.6 3.2-2.6"/><circle cx="16.6" cy="16.8" r="1.1" fill="currentColor" stroke="none"/><circle cx="7" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
    scale: '<path d="M12 3.5v17M6.5 6.5h11"/><path d="M6.5 6.5 3 13.2h7z"/><path d="M17.5 6.5 14 13.2h7z"/><path d="M8 20.5h8"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.4"/>',
    hand: '<path d="M8.2 12V6.4a1.6 1.6 0 0 1 3.2 0V11M11.4 10.6V4.9a1.6 1.6 0 0 1 3.2 0V11M14.6 11.2V6.6a1.6 1.6 0 0 1 3.2 0v7.2a6.2 6.2 0 0 1-6.2 6.2h-1.2a5 5 0 0 1-4.1-2.2L3.6 13.6a1.7 1.7 0 0 1 2.7-2l1.9 2.2"/>',
    chair: '<path d="M6.5 3.5v9h11v-9"/><path d="M4.5 12.5h15"/><path d="M7.5 12.5v8M16.5 12.5v8"/>'
  };

  /* Emoji that shipped before the SVG set. Each maps to a named icon; the
     fallback (sparkle) keeps an unknown glyph from ever reaching the screen. */
  const EMOJI = {
    '🧊': 'cube', '🎬': 'film', '🏞': 'landscape', '🌄': 'landscape', '💥': 'bolt', '🗿': 'skull',
    '🎭': 'masks', '🎨': 'palette', '🖼': 'image', '📂': 'folder', '🏠': 'home', '⌂': 'home',
    '🔒': 'lock', '🔓': 'unlock', '⚙': 'gear', '✕': 'close', '❌': 'close', '✖': 'close',
    '✅': 'check', '✔': 'check', '➕': 'plus', '➖': 'minus', '🗑': 'trash', '🔄': 'refresh',
    '↻': 'refresh', '↺': 'refresh', '↶': 'undo', '↷': 'redo', '🔍': 'search', '🔎': 'search',
    '👁': 'eye', '▶': 'play', '⏸': 'pause', '⏺': 'record', '⏹': 'stop', '🎥': 'video',
    '📷': 'camera', '🎯': 'target', '✨': 'sparkle', '🌐': 'globe', '🌍': 'globe', '🗺': 'map',
    '⛰': 'mountain', '🏔': 'mountain', '🌲': 'tree', '🌴': 'palms', '🌿': 'leaf', '🍃': 'leaf',
    '🌱': 'sprout', '🪴': 'flower', '🌵': 'cactus', '🪨': 'rock', '🌋': 'volcano', '🌊': 'water',
    '💧': 'droplet', '❄': 'snow', '☀': 'sun', '🌞': 'sun', '🌙': 'moon', '🌅': 'sunrise',
    '🌇': 'sunset', '🌃': 'moon', '🏙': 'city', '🪐': 'planet', '🚀': 'rocket', '🔥': 'flame',
    '💨': 'wind', '☁': 'cloud', '💦': 'droplets', '🧱': 'grid', '📚': 'layers', '🎚': 'sliders',
    '🎛': 'sliders', '📁': 'folder', '🎞': 'film',
    '🔮': 'orb', '🍩': 'torus', '🛢': 'log', '🧹': 'broom', '🏀': 'sphere', '🎈': 'sphere',
    '💓': 'pulse', '🕰': 'clock', '✊': 'hand', '🤏': 'hand', '✎': 'pen', '🚫': 'ban',
    '✓': 'check', '🏝': 'palms', '🌾': 'grass', '🌼': 'flower', '🌷': 'flower',
    '🌸': 'flower', '💜': 'heart', '🌳': 'tree', '🪵': 'log', '🕳': 'hole', '🏜': 'dunes',
    '🍂': 'leaf', '🏢': 'city', '🏬': 'city', '🗻': 'mountain', '🌫': 'fog', '🌦': 'rain',
    '🌧': 'rain', '⛈': 'rain', '🌨': 'snow', '🌪': 'tornado', '🌌': 'galaxy', '🪑': 'chair',
    '⚖': 'scale', '⬜': 'square', '🟦': 'square', '🔳': 'square', '🔲': 'square', '📏': 'ruler',
    '⬅': 'arrowRight', '⬆': 'arrowUp', '⏮': 'skipBack', '⏭': 'skipForward', '🛋': 'chair',
    '🪄': 'wand', '✏': 'pen', '🖌': 'brush', '🖍': 'pen', '🧽': 'eraser', '📐': 'ruler',
    '🧭': 'cube3d', '📦': 'box', '🔗': 'link', '🔔': 'bell', 'ℹ': 'info', '💡': 'info',
    '⚠': 'warning', '⏱': 'clock', '⏳': 'clock', '❓': 'help', '📋': 'list', '🎲': 'dice',
    '📊': 'activity', '📈': 'activity', '🧪': 'flask', '🔬': 'flask', '💾': 'save', '📤': 'upload',
    '📥': 'download', '📲': 'phone', '📱': 'phone', '🖥': 'desktop', '💻': 'desktop', '🔧': 'gear',
    '🛠': 'sliders', '🧩': 'nodes', '🕸': 'nodes', '⌗': 'hash', '🟢': 'dot', '🔵': 'dot',
    '🟠': 'dot', '🟡': 'dot', '🔴': 'dot', '⚪': 'dot', '⚫': 'dot', '⚡': 'bolt', '💤': 'moon',
    '✋': 'pin', '🖐': 'pin', '👆': 'pin', '⇧': 'arrowUp', '→': 'arrowRight', '←': 'arrowRight',
    '▼': 'chevronDown', '▶︎': 'play', '⛶': 'grid', '◼': 'stop', '◻': 'shape', '●': 'dot',
    '✦': 'sparkle', '✧': 'sparkle', '⚑': 'pin', '🏷': 'pin', '🧮': 'ruler', '🪶': 'pen'
  };

  const SKIP_PARENTS = new Set(['OPTION', 'TEXTAREA', 'SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT']);

  /* Emoji + variation selectors + zero width joiner. Deliberately explicit so
     arrows and geometric marks (which are not emoji) keep their meaning. */
  const EMOJI_RE = /[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]|[\u{1F000}-\u{1FAFF}]/gu;

  function svg(name, options) {
    const key = PATHS[name] ? name : 'sparkle';
    const size = (options && options.size) || 18;
    const cls = (options && options.className) || 'ico';
    return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[key]}</svg>`;
  }

  function hydrateText(node) {
    let text = node.nodeValue;
    if (!text || !EMOJI_RE.test(text)) return;
    EMOJI_RE.lastIndex = 0;
    const parent = node.parentNode;
    if (!parent) return;
    /* Never touch code or raw-data elements: their text is source, not UI. */
    if (parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE' || parent.nodeName === 'NOSCRIPT') return;
    const stripped = text.replace(/\uFE0F/g, '');
    text = stripped;
    if (!EMOJI_RE.test(text)) { node.nodeValue = text; return; }
    EMOJI_RE.lastIndex = 0;
    if (parent.nodeName === 'OPTION' || parent.nodeName === 'TEXTAREA' || parent.nodeName === 'TITLE') {
      node.nodeValue = text.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
      return;
    }
    const frag = document.createDocumentFragment();
    let last = 0, match;
    while ((match = EMOJI_RE.exec(text))) {
      const glyph = match[0];
      if (glyph === '\uFE0F' || glyph === '\u200D' || glyph === '\u20E3') continue;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const icon = document.createElement('span');
      icon.className = 'ico-wrap';
      icon.innerHTML = svg(EMOJI[glyph] || 'sparkle');
      frag.appendChild(icon);
      last = match.index + glyph.length;
    }
    if (last === 0) {
      node.nodeValue = text.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
      return;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  }

  function hydrate(root) {
    const host = root || document.body;
    if (!host || !document.createTreeWalker) return 0;
    let count = 0;
    /* 1. declarative placeholders: <i class="ico" data-ico="cube"></i> */
    if (host.querySelectorAll) {
      host.querySelectorAll('i[data-ico]').forEach((el) => {
        el.innerHTML = svg(el.getAttribute('data-ico'), { size: Number(el.getAttribute('data-size')) || 18 });
        el.classList.add('ico-wrap');
        el.removeAttribute('data-ico');
        count++;
      });
    }
    /* 2. attributes: tooltips and screen-reader labels cannot hold SVG, so the
       glyph is simply removed instead of shipped as text. */
    if (host.querySelectorAll) {
      host.querySelectorAll('[title],[aria-label],[placeholder],[alt]').forEach((el) => {
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
          const value = el.getAttribute(attr);
          if (!value || !EMOJI_RE.test(value)) continue;
          EMOJI_RE.lastIndex = 0;
          el.setAttribute(attr, value.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim());
        }
      });
    }
    /* 3. any emoji that survived in text (templates, toasts, terrain page) */
    const walker = document.createTreeWalker(host, 4 /* SHOW_TEXT */, null);
    const nodes = [];
    let found;
    while ((found = walker.nextNode())) nodes.push(found);
    for (const node of nodes) {
      const before = node.nodeValue;
      if (!before) continue;
      hydrateText(node);
      if (node.nodeValue !== before || !node.isConnected) count++;
    }
    return count;
  }

  function start() {
    if (typeof document === 'undefined') return;
    hydrate(document.body);
    document.documentElement.classList.add('fe-icons-ready');
    if (typeof MutationObserver !== 'function') return;
    const pending = new Set();
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      try {
        pending.forEach((node) => { if (node.isConnected) hydrate(node); });
      } catch (_) {}
      pending.clear();
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') { pending.add(record.target.parentNode); continue; }
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) pending.add(node);
          else if (node.nodeType === 3) pending.add(node.parentNode);
        }
      }
      if (pending.size && !scheduled) {
        scheduled = true;
        (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(flush);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  const glyphIcon = (glyph) => EMOJI[glyph] || null;
  const api = { svg, hydrate, start, glyphIcon, emoji: EMOJI, names: Object.keys(PATHS) };
  global.FEIcons = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
