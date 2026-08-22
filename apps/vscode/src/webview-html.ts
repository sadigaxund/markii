/**
 * Builds the HTML shell `preview-panel.ts` assigns to `webview.html`. Kept
 * `vscode`-free and pure (options in, string out) so it is plain,
 * unit-tested TypeScript — the security-relevant parts (the CSP, and escaping
 * every interpolated value) are exactly the parts worth testing in
 * isolation, without a real `vscode.Webview` in the loop.
 */

import { randomBytes } from 'node:crypto';

export interface WebviewHtmlOptions {
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly cspSource: string;
  readonly nonce: string;
  readonly title: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the five HTML-significant characters. Written by hand (no dependency) per AGENTS.md's dependency rule — this is the extension's ONLY place untrusted/host-supplied text is interpolated into markup. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Builds the webview document's `<head>`/`<body>` shell. `#root` holds an
 * empty `.doc` placeholder — `webview/main.tsx` mounts React onto `#root`
 * and immediately replaces its contents, so the placeholder is never
 * visible in practice; it exists only so the shell is valid, renderable
 * markup even for the instant before the bundle's script runs.
 *
 * Every option is treated as untrusted text and run through `escapeHtml`
 * before interpolation — `scriptUri`/`styleUri`/`cspSource` come from
 * `vscode.Webview.asWebviewUri`/`cspSource`, `nonce` from `createNonce`
 * below, and `title` is a static string today, but none of that is assumed
 * here: nothing reaches the markup unescaped.
 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const scriptUri = escapeHtml(options.scriptUri);
  const styleUri = escapeHtml(options.styleUri);
  const cspSource = escapeHtml(options.cspSource);
  const nonce = escapeHtml(options.nonce);
  const title = escapeHtml(options.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!--
  Content-Security-Policy, directive by directive:

  - script-src is nonce-only: no 'unsafe-inline', no remote host. The
    webview bundle (dist/webview/main.js) is a single classic IIFE built by
    esbuild.config.mjs — nothing else is ever fetched or evaluated at
    runtime, so a fresh nonce per HTML load is sufficient, and strictly
    tighter than allowing inline script generally.

  - style-src allows 'unsafe-inline' because the standard component set
    sets style ATTRIBUTES directly at render time — e.g.
    packages/platforms/markii-react/src/components/progress.tsx's
    style={{ width: ... }} bar fill (~line 121) and chart.tsx's empty-state
    box sizing (~line 212) — and CSP's style-src governs style ATTRIBUTES
    too whenever the narrower style-src-attr is absent, which it is here.
    There is no attribute-only keyword that would let those components keep
    working without this.

  - img-src allows https: and data: so document images and figure
    directives can load — the same posture VS Code's own built-in markdown
    preview takes — at the cost that opening a document with a remote image
    contacts that image's host. Its cspSource term is what additionally
    permits LOCAL images: a relative src is rewritten to the document
    folder's asWebviewUri form (webview/document-images.ts), which is a
    cspSource URL. That widens nothing on its own — which local files may
    actually be served is decided by the panel's localResourceRoots
    (preview-panel.ts), not by this policy.
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>${title}</title>
</head>
<body>
<div id="root"><div class="doc"></div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`;
}

const NONCE_LENGTH = 32;
const NONCE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');

/**
 * Picks one nonce character from a `[0, 1)` random sample. Falls back to
 * the first character for an out-of-range sample (a hostile/buggy injected
 * `randomValues` returning exactly `1` or something negative) rather than
 * indexing out of bounds — `NONCE_CHARS[index]` is `string | undefined`
 * under `noUncheckedIndexedAccess`, so this is the one place that ever
 * needs to be defensive about it.
 */
function pickNonceChar(sample: number): string {
  const clamped = Math.min(Math.max(sample, 0), 1 - Number.EPSILON);
  const index = Math.floor(clamped * NONCE_CHARS.length);
  return NONCE_CHARS[index] ?? 'A';
}

/**
 * A `[0, 1)` sample drawn from `node:crypto`'s CSPRNG (N-9 fix,
 * PENTEST-REPORT-2026-08-23.md) rather than `Math.random`, which is not
 * cryptographically strong in V8 and is unsuitable as the sole source of
 * entropy for something whose whole job is being unguessable. Reads 4 random
 * bytes as an unsigned 32-bit integer and scales it into `[0, 1)`, matching
 * `Math.random`'s own contract closely enough that `pickNonceChar` needs no
 * changes.
 */
function cryptoRandom(): number {
  return randomBytes(4).readUInt32BE(0) / 0x100000000;
}

/**
 * Generates a fresh 32-character `[A-Za-z0-9]` nonce for one `script-src
 * 'nonce-...'` CSP value / `<script nonce="...">` pair. `preview-panel.ts`
 * calls this once per `buildWebviewHtml` call (never reused across HTML
 * loads, so a stale nonce can never authorize a new script).
 *
 * `randomValues` defaults to `cryptoRandom` (a CSPRNG source) and is
 * injectable so tests get a deterministic sequence instead of depending on
 * real randomness.
 */
export function createNonce(randomValues: () => number = cryptoRandom): string {
  let nonce = '';
  for (let i = 0; i < NONCE_LENGTH; i++) {
    nonce += pickNonceChar(randomValues());
  }
  return nonce;
}
