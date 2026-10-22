// What importing a file that is not code gives you, so the editor knows. The build inlines each
// into plugin.js: an image or font as a data: URL, a stylesheet as its text (or, imported with
// nothing bound — `import "x.css"` — applied to the page), a .wasm file as its bytes.
declare module "*.png" { const url: string; export default url; }
declare module "*.jpg" { const url: string; export default url; }
declare module "*.jpeg" { const url: string; export default url; }
declare module "*.gif" { const url: string; export default url; }
declare module "*.webp" { const url: string; export default url; }
declare module "*.svg" { const url: string; export default url; }
declare module "*.woff2" { const url: string; export default url; }
declare module "*.css" { const text: string; export default text; }
declare module "*.wasm" { const bytes: Uint8Array; export default bytes; }
// `import text from "some/file?raw"`: any file, as its text.
declare module "*?raw" { const text: string; export default text; }
// `import data from "some/file?base64"`: any file's bytes, as a base64 string.
declare module "*?base64" { const base64: string; export default base64; }
