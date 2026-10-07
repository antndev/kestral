import type { ITheme } from "@xterm/xterm";

export type TermTheme = { name: string; theme: ITheme };
export type TermThemeId = string;

export const TERMINAL_THEMES: Record<string, TermTheme> = {
  "kestral-dark": {
    name: "Kestral",
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#e4e4e4",
      cursorAccent: "#1e1e1e",
      selectionBackground: "#2d4f67",
      black: "#1e1e1e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#c0caf5",
      brightBlack: "#6b7089",
      brightRed: "#ff899d",
      brightGreen: "#b9f27c",
      brightYellow: "#ff9e64",
      brightBlue: "#9ab8ff",
      brightMagenta: "#c7a9ff",
      brightCyan: "#a4daff",
      brightWhite: "#ffffff",
    },
  },
  production: {
    name: "Red for production",
    theme: {
      background: "#241214",
      foreground: "#f1dada",
      cursor: "#ff8a8a",
      cursorAccent: "#241214",
      selectionBackground: "#5c2a2f",
      black: "#241214",
      red: "#ff6b6b",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#8ab4f8",
      magenta: "#d79ae6",
      cyan: "#7dcfff",
      white: "#e8d4d4",
      brightBlack: "#8a6266",
      brightRed: "#ff8f8f",
      brightGreen: "#b9f27c",
      brightYellow: "#ffb86c",
      brightBlue: "#a7c7ff",
      brightMagenta: "#e5b3f2",
      brightCyan: "#a4daff",
      brightWhite: "#ffffff",
    },
  },
  "tokyo-night": {
    name: "Tokyo Night",
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  dracula: {
    name: "Dracula",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  "one-dark": {
    name: "One Dark",
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    name: "Solarized Dark",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#719e07",
      brightYellow: "#b58900",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  "gruvbox-dark": {
    name: "Gruvbox Dark",
    theme: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  "solarized-light": {
    name: "Solarized Light",
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
};

export const DEFAULT_TERM_THEME: TermThemeId = "kestral-dark";

export function termThemeOf(id: TermThemeId): TermTheme {
  return TERMINAL_THEMES[id] ?? TERMINAL_THEMES[DEFAULT_TERM_THEME];
}

export function terminalTheme(id: TermThemeId, colors: boolean): ITheme {
  const base = termThemeOf(id).theme;
  if (colors) return base;
  const fg = base.foreground ?? "#d4d4d4";
  const dim = base.brightBlack ?? "#888888";
  return {
    ...base,
    black: fg,
    red: fg,
    green: fg,
    yellow: fg,
    blue: fg,
    magenta: fg,
    cyan: fg,
    white: fg,
    brightBlack: dim,
    brightRed: fg,
    brightGreen: fg,
    brightYellow: fg,
    brightBlue: fg,
    brightMagenta: fg,
    brightCyan: fg,
    brightWhite: fg,
  };
}

export type Tone = "dark" | "light";
export function toneOf(el: Element | null): Tone {
  return el?.closest(".t-dark, .t-light")?.classList.contains("t-light") ? "light" : "dark";
}

function monochrome(t: ITheme): ITheme {
  const fg = t.foreground;
  return {
    ...t,
    black: fg,
    red: fg,
    green: fg,
    yellow: fg,
    blue: fg,
    magenta: fg,
    cyan: fg,
    white: fg,
    brightRed: fg,
    brightGreen: fg,
    brightYellow: fg,
    brightBlue: fg,
    brightMagenta: fg,
    brightCyan: fg,
    brightWhite: fg,
  };
}

/**
 * The xterm theme actually used for a scheme. The default scheme follows the app's
 * terminal tokens (dark or light) read from the themed ancestor of `el`, so the
 * terminal matches its pane headers; other schemes keep their own palette.
 */
export function resolveTerminalTheme(id: string, colors: boolean, el: Element | null): ITheme {
  let theme = termThemeOf(id).theme;
  if (id === DEFAULT_TERM_THEME && el) {
    const cs = getComputedStyle(el);
    const tok = (name: string, fallback: string | undefined) => cs.getPropertyValue(name).trim() || fallback;
    const bg = tok("--term-bg", theme.background);
    const fg = tok("--term-text", theme.foreground);
    const dim = tok("--term-dim", theme.brightBlack);
    if (toneOf(el) === "light") {
      const magenta = "#8a3fa6";
      const cyan = "#14798a";
      theme = {
        background: bg,
        foreground: fg,
        cursor: fg,
        cursorAccent: bg,
        selectionBackground: tok("--accent-tint", "#e6ecfa"),
        black: fg,
        red: tok("--err", "#b3261e"),
        green: tok("--ok", "#2e7d4f"),
        yellow: tok("--warn", "#b35c00"),
        blue: tok("--accent", "#2b59c3"),
        magenta,
        cyan,
        white: dim,
        brightBlack: dim,
        brightRed: tok("--err", "#b3261e"),
        brightGreen: tok("--ok", "#2e7d4f"),
        brightYellow: tok("--warn", "#b35c00"),
        brightBlue: tok("--link", "#2b59c3"),
        brightMagenta: magenta,
        brightCyan: cyan,
        brightWhite: fg,
      };
    } else {
      theme = { ...theme, background: bg, foreground: fg, cursor: fg, cursorAccent: bg };
    }
  }
  return colors ? theme : monochrome(theme);
}
