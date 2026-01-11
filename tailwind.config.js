/** @type {import('tailwindcss').Config} */
export default {
  content: ["public/**/*.html", "public/**/*.js"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Noto Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          '"Noto Sans Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        surface: "0 20px 50px -40px rgba(0, 0, 0, 0.7)",
      },
    },
  },
};
