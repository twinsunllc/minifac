## 1. Loader

- [x] 1.1 `src/library/library.ts`: `parseDeclaration` accepts an optional
      non-empty string `range`, refuses any other value naming the file, and
      carries it on `LibraryDeclaration`; the unknown-key message names
      `range` as optional
- [x] 1.2 `src/library/library.test.ts`: a declared range still resolves at
      `ref` when a newer tag exists; no `range` key without one; a numeric,
      empty or list range is refused; another key is still refused
- [x] 1.3 `README.md` library block and `CHANGELOG.md` `[Unreleased]` bullet
