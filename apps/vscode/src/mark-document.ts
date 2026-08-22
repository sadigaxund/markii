/**
 * Document-shape predicates shared by `extension.ts`/`preview-panel.ts`.
 * Kept `vscode`-free (structural parameter types only, never `vscode.*`
 * types) so this module — unlike `preview-panel.ts` — is plain, unit-tested
 * TypeScript: vitest cannot resolve the `vscode` module at all, so nothing
 * a `*.test.ts` file exercises may import it.
 */

/** The canonical Markii file extension, matching `package.json`'s `contributes.languages[0].extensions`. */
export const MARK_EXTENSION = '.mk.md';

/**
 * True when `fileName` ends with `.mk.md` (case-insensitively) AND has a
 * non-empty base name before it — a bare `.mk.md` with nothing in front
 * (no author-chosen name) is rejected, not treated as a valid Markii file.
 */
export function isMarkFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(MARK_EXTENSION)) return false;
  return lower.length > MARK_EXTENSION.length;
}

/** Shown when a document has no usable base name (an unsaved buffer whose URI path is empty). */
export const FALLBACK_PREVIEW_TITLE = 'Markii Preview';

/**
 * The webview panel's tab title for the document at `uriPath` — "Preview
 * notes.mk.md", matching how VS Code's own markdown preview names its tab.
 * Because this preview FOLLOWS the active editor (see `preview-panel.ts`),
 * a static title would leave a reader unable to tell which document they
 * are looking at once they have switched files.
 *
 * Takes the URI *path* (always `/`-separated, regardless of platform —
 * `vscode.Uri.path`, never `fsPath`), so no `node:path` import and no
 * platform branching is needed here.
 */
export function previewTitleFor(uriPath: string): string {
  const baseName = uriPath.split('/').pop() ?? '';
  return baseName ? `Preview ${baseName}` : FALLBACK_PREVIEW_TITLE;
}

/** The minimal shape `isPreviewableDocument` needs off a `vscode.TextDocument` — deliberately structural, not `vscode.TextDocument` itself, to keep this module import-free. */
export interface PreviewableDocumentLike {
  readonly languageId: string;
  readonly uri: { readonly scheme: string };
}

/**
 * Schemes a preview may follow the active editor into. `file` and
 * `untitled` are real editable documents; every other scheme (`output`,
 * `git`, `vscode-userdata`, the preview webview's own `markii.preview`,
 * ...) is excluded so an Output pane, a diff view, or the preview panel
 * itself gaining focus can never hijack — or blank — the preview.
 */
const PREVIEWABLE_SCHEMES: ReadonlySet<string> = new Set(['file', 'untitled']);

/** True when `document` is a markdown-language document living in a real (file or unsaved) editor — the set of documents the preview is willing to follow. */
export function isPreviewableDocument(
  document: PreviewableDocumentLike,
): boolean {
  return (
    document.languageId === 'markdown' &&
    PREVIEWABLE_SCHEMES.has(document.uri.scheme)
  );
}
