# Bundled fonts — attribution

This directory contains a font file redistributed under its original
permissive license:

## Symbols Nerd Font Mono

- File: `SymbolsNerdFontMono-Regular.ttf`
- Source: https://github.com/ryanoasis/nerd-fonts (NerdFontsSymbolsOnly)
- License: MIT (Nerd Fonts patches), aggregated from many upstream
  icon sources, each under their own permissive license (Apache 2.0,
  MIT, OFL, etc.)
- Why bundled: Claude Code's TUI uses Nerd Font glyphs for spinners
  and file/folder/git icons. Bundling the symbols-only variant lets
  the app render them without requiring users to install a Nerd Font
  on their system. Loaded via `@font-face` with `unicode-range`
  scoped to the icon code points only.
