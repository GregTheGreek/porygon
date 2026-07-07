import type { Config } from 'tailwindcss';

// Neutral, VS Code-ish dark grays. No blue tint. Steps preserve clear
// contrast between the docked panel layers.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#1e1e20',
          raised: '#252528',
          panel: '#2a2a2d',
          input: '#37373b',
          border: '#3a3a3e',
        },
        fg: {
          DEFAULT: '#ebebec',
          muted: '#a5a5a8',
          subtle: '#707075',
        },
        accent: {
          DEFAULT: '#7c5cff',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
