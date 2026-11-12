/* Line icons (24×24, drawn for Cliploom). Icons.svg(name) -> markup string. */
(function (root) {
  const P = {
    close: 'M6 6l12 12M18 6L6 18',
    back: 'M15 5l-7 7 7 7',
    plus: 'M12 5v14M5 12h14',
    play: 'M8 5.5v13l10.5-6.5z',
    pause: 'M8 5v14M16 5v14',
    undo: 'M9 7H5V3M5.5 7.5A8 8 0 1 1 4 13',
    redo: 'M15 7h4V3M18.5 7.5A8 8 0 1 0 20 13',
    full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    media: 'M4 5h16v14H4zM4 9h16M8 5v4M12 5v4M16 5v4M10.5 12.5v4l3.5-2z',
    audio: 'M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM9 18V5l10-2v12M19 15a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
    text: 'M5 6V4h14v2M12 4v16M9 20h6',
    sticker: 'M12 3a9 9 0 1 0 9 9M21 12a9 9 0 0 1-9-9M12 3c0 5 4 9 9 9M8.5 14.5c1.8 2 5.2 2 7 0M9 9.5h.01M14 9.5h.01',
    filter: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18M12 7l5.5 2M12 12h8.5M12 17l5.5-2',
    shape: 'M4 6h10v12H4zM17 9h3v6h-3',
    split: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L11 11',
    speed: 'M5 17a8 8 0 1 1 14 0M12 13l4-4M12 13a1 1 0 1 0 0 .01',
    volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
    mute: 'M4 9h4l5-4v14l-5-4H4zM17 9.5l5 5M22 9.5l-5 5',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
    detach: 'M9 17a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM9 17V5l8-2M15 13l3 3 3-3M18 16V8',
    transition: 'M3 5l9 7-9 7zM21 5l-9 7 9 7z',
    fade: 'M4 20L20 4M4 20h16',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    adjust: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
    crop: 'M6 2v16h16M2 6h16v16',
    effects: 'M12 3l2.2 5.3L20 9l-4.4 3.8L17 19l-5-3-5 3 1.4-6.2L4 9l5.8-.7z',
    overlay: 'M3 4h13v10H3zM9 10h12v10H9z',
    captions: 'M3 5h18v14H3zM7 13h4M13 13h4M7 16h7M16 16h1',
    ai: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM18 13l.9 2.1L21 16l-2.1.9L18 19l-.9-2.1L15 16l2.1-.9z',
    avatar: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7M18 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
    ratio: 'M3 6h11v12H3zM17 4h4v16h-4',
    background: 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01',
    cover: 'M4 4h16v16H4zM4 15l4-4 4 4 2-2 6 6M8 4v4h8V4',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.6 4.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
    image: 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01M18 2l.5 1.5L20 4l-1.5.5L18 6l-.5-1.5L16 4l1.5-.5z',
    video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3z',
    chat: 'M4 5h11v8H8l-4 3zM10 16h6l4 3v-9h-3',
    folder: 'M3 6h6l2 2h10v11H3z',
    voice: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v4',
  };
  const Icons = {
    svg(name, size) {
      const d = P[name] || P.plus;
      const s = size || 24;
      const fill = name === 'play' ? 'currentColor' : 'none';
      return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="' + fill + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
    },
  };
  root.Icons = Icons;
})(window);
