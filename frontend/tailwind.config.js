export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#162D33', soft: '#62798A', hover: '#243F46' },
        muted: '#8C9AA8',
        slate: '#7B8994',
        paper: '#FFFFFF',
        surface: '#FBFBFC',
        line: '#EEF1F4',
        sand: '#EEF1F4',
        edge: '#8794A2',
        brand: { DEFAULT: '#087C73', hover: '#06675F', tint: '#E5F2F5', soft: '#F2F7F5' },
        orange: { DEFAULT: '#ED8B12', dark: '#A85F00', light: '#FDF2E0' },
        lavender: '#F5F1F6',
        danger: '#B3261E',
      },
      boxShadow: { card: '0 1px 2px rgba(22, 45, 51, 0.04)' },
      fontFamily: {
        sans: ['"Figtree Variable"', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        display: ['"Plus Jakarta Sans Variable"', '"Figtree Variable"', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '12px', '2xl': '16px', '3xl': '20px' },
      fontSize: { display: ['clamp(2rem, 5vw, 3.5rem)', { lineHeight: '1.08', letterSpacing: '-0.025em', fontWeight: '700' }] },
    },
  },
  plugins: [],
};
