# Inkwell

A beautiful, minimal Markdown viewer for macOS.

## Features

- Clean, distraction-free reading experience
- Dark mode (Cmd+D)
- Edit source with save (Cmd+U to toggle, Cmd+S to save)
- Export to PDF (Cmd+E) and HTML (Cmd+Shift+E)
- Print support (Cmd+P)
- Live file watching with auto-reload
- Find in document (Cmd+F)
- Recent files menu
- Word and character count in status bar
- Keyboard shortcuts help (Cmd+/)
- Persisted window size and zoom level
- Syntax highlighting for code blocks
- GitHub Flavored Markdown (GFM) support
- Drag and drop files to open
- Native macOS look and feel
- File associations for `.md` and `.markdown` files

## Installation

### Homebrew (Recommended)

```bash
brew tap outemp/inkwell
brew install --cask --no-quarantine inkwell
```

> **Note:** The `--no-quarantine` flag is required because the app is not code-signed.

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
- **Find**: Use `Cmd+F` to search within the document
- **View/Edit source**: Use `Cmd+U` to toggle editable source view
- **Save**: Use `Cmd+S` to save changes (in source view)
- **Export**: Use `Cmd+E` for PDF, `Cmd+Shift+E` for HTML
- **Print**: Use `Cmd+P` to print
- **Dark mode**: Use `Cmd+D` to toggle dark mode
- **Recent files**: File > Open Recent
- **Zoom**: Use `Cmd++` / `Cmd+-` to adjust text size
- **Shortcuts**: Use `Cmd+/` to see all keyboard shortcuts

## Tech Stack

- [Electron](https://www.electronjs.org/) - Cross-platform desktop apps
- [marked](https://marked.js.org/) - Markdown parser
- [highlight.js](https://highlightjs.org/) - Syntax highlighting

## License

MIT
