# Inkwell

A beautiful, minimal Markdown viewer for macOS.

## Features

- Clean, distraction-free reading experience
- Syntax highlighting for code blocks
- GitHub Flavored Markdown (GFM) support
- Drag and drop files to open
- Native macOS look and feel
- File associations for `.md` and `.markdown` files

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/outemp/inkwell.git
cd inkwell

# Install dependencies
npm install

# Run the app
npm start
```

### Build for macOS

```bash
npm run build
```

This creates a `.dmg` installer in the `dist/` folder.

## Usage

- **Open a file**: Use `Cmd+O` or drag a `.md` file onto the window
- **Double-click**: Associate `.md` files with Inkwell to open them directly
- **Zoom**: Use `Cmd++` / `Cmd+-` to adjust text size

## Tech Stack

- [Electron](https://www.electronjs.org/) - Cross-platform desktop apps
- [marked](https://marked.js.org/) - Markdown parser
- [highlight.js](https://highlightjs.org/) - Syntax highlighting

## License

MIT
