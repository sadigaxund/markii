import * as vscode from 'vscode';
import { createDebouncer } from './debounce.js';
import { isPreviewableDocument, previewTitleFor } from './mark-document.js';
import { isWebviewToHostMessage } from './protocol.js';
import type { HostToWebviewMessage, ValuesMessage } from './protocol.js';
import { isCoveredByRoots, withTrailingSlash } from './resource-roots.js';
import { buildWebviewHtml, createNonce } from './webview-html.js';
import {
  ALLOW_LABEL,
  DONT_ALLOW_LABEL,
  UNKNOWN_HOSTS_PROMPT_MESSAGE,
  hostPromptMessage,
} from './run/grant-flow.js';
import { spawnRun } from './run/run-host.js';
import { runOnce } from './run/run-flow.js';

/**
 * Imports `vscode` — deliberately NOT unit-tested (vitest cannot resolve
 * `vscode`), per the extension's file-scope split. Every piece of logic
 * worth testing in isolation (message validation, debouncing, document
 * classification, HTML/CSP construction) already lives in the plain
 * modules imported above; this file is wiring only.
 */

const VIEW_TYPE = 'markii.preview';
/** External wall-clock budget for one `markii.runScripts` press — forwarded verbatim to `spawnRun`'s own watchdog (`run/run-host.ts`); the worker cannot influence or extend it. */
const RUN_TIMEOUT_MS = 15_000;
/** The `when`-clause context key `package.json`'s `markii.runScripts` menu entries gate on — kept in sync with true whenever a preview panel exists, false once it's disposed. */
const PREVIEW_ACTIVE_CONTEXT_KEY = 'markii.previewActive';
/**
 * The webview DOCUMENT's `<title>` — never visible in the editor (the tab
 * label is `panel.title`, set per document by `postUpdate`), but it is what
 * the webview developer-tools window and screen readers announce.
 */
const DOCUMENT_TITLE = 'Markii Preview';
const DEBOUNCE_MS = 200; // matches apps/playground/src/App.tsx's DEBOUNCE_MS

interface ActivePreview {
  readonly panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  revision: number;
  /** `scheme://authority/path` keys of the `localResourceRoots` this panel was created with — see `retargetPreview`. Fixed for the panel's whole life, because `localResourceRoots` itself is. */
  readonly rootKeys: readonly string[];
  readonly debouncer: ReturnType<typeof createDebouncer<void>>;
  /**
   * Set for the duration of one `markii.runScripts` press. `runScripts`
   * below IGNORES a press that arrives while this is already `true` —
   * chosen over cancel-and-restart because a run's cache-snapshot mutation
   * (`run/run-flow.ts`'s `runOnce`) is only safe to persist once a run has
   * fully finished; cancelling mid-run would leave no well-defined snapshot
   * to write back.
   */
  running: boolean;
}

/** The comparable key form of a URI for `resource-roots.ts` — scheme and authority included, so a `file:` root can never be mistaken for a same-path root on another scheme or remote authority. */
function rootKey(uri: vscode.Uri): string {
  return `${uri.scheme}://${uri.authority}${uri.path}`;
}

/**
 * The folder the document lives in, or `undefined` when it has none — an
 * `untitled:` buffer has never been written anywhere, so there is no folder
 * for its relative images to resolve against. Callers degrade to "no base
 * URI" in that case; remote/absolute images keep working regardless.
 */
function documentFolder(document: vscode.TextDocument): vscode.Uri | undefined {
  if (document.uri.scheme === 'untitled') return undefined;
  return vscode.Uri.joinPath(document.uri, '..');
}

/**
 * The panel's `localResourceRoots`: the bundled webview assets, every
 * workspace folder, and the previewed document's own folder.
 *
 * DECISION — roots are set BROADLY at creation, and the panel is recreated
 * (`retargetPreview`) only when the preview follows the editor somewhere no
 * root covers. `localResourceRoots` cannot be widened after creation, so the
 * alternatives were: (a) recreate the panel on every document switch —
 * correct but visibly destroys and rebuilds the preview constantly; (b)
 * grant a very wide root such as the file-system root — one line, and an
 * open door from any previewed note to any file on the machine; (c) this.
 * Including all workspace folders means the common cases (a note in the open
 * project, a multi-root workspace) never recreate anything, while a note
 * opened from outside the workspace costs exactly one recreation and gets
 * its own folder — and nothing beyond it — added.
 */
function localResourceRootsFor(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
): vscode.Uri[] {
  const roots: vscode.Uri[] = [
    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri);
  }
  const folder = documentFolder(document);
  if (folder) roots.push(folder);
  return roots;
}

/**
 * The one preview panel this extension ever has open — `openPreview`
 * reveals/redirects it rather than opening a second, matching how VS Code's
 * own built-in markdown preview follows a single panel across the active
 * editor. `undefined` whenever no panel is open; set in `createPreview`,
 * cleared in the panel's `onDidDispose` handler.
 */
let active: ActivePreview | undefined;

/**
 * Sends the tracked document's current text as a fresh `update`, bumping
 * `revision` first so every message this extension ever sends is
 * monotonically numbered — `isNewerRevision` (`protocol.ts`) on the webview
 * side relies on that to ignore anything older than what it already
 * rendered.
 */
function postUpdate(preview: ActivePreview): void {
  // The tab is renamed with every post rather than only on switch: the
  // panel follows the active editor, so its title is the only place a
  // reader can see WHICH document is on screen (an unsaved buffer can also
  // be renamed under us by a save).
  preview.panel.title = previewTitleFor(preview.document.uri.path);
  preview.revision += 1;
  const baseUri = baseUriFor(preview);
  const message: HostToWebviewMessage = {
    type: 'update',
    revision: preview.revision,
    text: preview.document.getText(),
    // Spread rather than `baseUri: undefined`: `postMessage`'s structured
    // clone preserves an own property whose value is `undefined`, and the
    // wire format says a document with no folder OMITS the field.
    ...(baseUri === undefined ? {} : { baseUri }),
  };
  void preview.panel.webview.postMessage(message);
}

/**
 * The webview-visible URI of the tracked document's folder, with a trailing
 * `/` so relative sources resolve INSIDE it (see `withTrailingSlash`), or
 * `undefined` for a document with no folder. `asWebviewUri` only ever
 * produces a loadable URL for a path inside the panel's
 * `localResourceRoots`; `retargetPreview` is what keeps that true.
 */
function baseUriFor(preview: ActivePreview): string | undefined {
  const folder = documentFolder(preview.document);
  if (!folder) return undefined;
  return withTrailingSlash(
    preview.panel.webview.asWebviewUri(folder).toString(),
  );
}

/** Builds and assigns the webview's HTML, with a FRESH nonce every time — a nonce authorizes exactly one script load and must never be reused across HTML assignments. */
function setHtml(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): void {
  const webview = panel.webview;
  const webviewDistUri = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'webview',
  );
  const scriptUri = webview
    .asWebviewUri(vscode.Uri.joinPath(webviewDistUri, 'main.js'))
    .toString();
  const styleUri = webview
    .asWebviewUri(vscode.Uri.joinPath(webviewDistUri, 'main.css'))
    .toString();

  webview.html = buildWebviewHtml({
    scriptUri,
    styleUri,
    cspSource: webview.cspSource,
    nonce: createNonce(),
    title: DOCUMENT_TITLE,
  });
}

/**
 * Switches the tracked document (used both when the command re-targets an
 * already-open panel, and when the active editor changes to a different
 * previewable document): drops any in-flight debounced update for the OLD
 * document — it would otherwise arrive after this synchronous, immediate
 * post and could stomp the new document's content with stale text — then
 * posts the new document's text right away.
 */
function switchDocument(
  preview: ActivePreview,
  document: vscode.TextDocument,
): void {
  preview.document = document;
  preview.debouncer.cancel();
  postUpdate(preview);
}

/**
 * Points the existing preview at `document` — the one entry point for
 * changing what the panel shows, used both by the command (re-targeting an
 * open panel) and by the follow-the-active-editor listener.
 *
 * Almost always this is a plain `switchDocument`. The exception is a
 * document whose folder no `localResourceRoots` entry covers: that set is
 * immutable after creation (see `localResourceRootsFor`), so the ONLY way to
 * let that document's images load is a fresh panel. It is recreated in the
 * same view column so the recreation reads as a refresh rather than the
 * preview jumping somewhere else.
 */
function retargetPreview(
  context: vscode.ExtensionContext,
  preview: ActivePreview,
  document: vscode.TextDocument,
): void {
  const folder = documentFolder(document);
  if (!folder || isCoveredByRoots(preview.rootKeys, rootKey(folder))) {
    switchDocument(preview, document);
    return;
  }

  const viewColumn = preview.panel.viewColumn;
  // Disposing runs the panel's own `onDidDispose` synchronously, which
  // clears `active` and unhooks every listener — including, possibly, the
  // one this call is running inside. That is safe (disposing an event
  // subscription during its own callback is supported), and `createPreview`
  // below immediately installs a fresh `active`.
  preview.panel.dispose();
  createPreview(context, document, viewColumn);
}

function activePreviewableDocument(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && isPreviewableDocument(editor.document)
    ? editor.document
    : undefined;
}

/**
 * Wires up the singleton panel's full lifecycle: the ready/update
 * handshake, following text edits (debounced) and the active editor
 * (immediately), and rehydration when the panel becomes visible again.
 *
 * DECISION — `retainContextWhenHidden: false` plus state rehydration,
 * NOT context retention: retaining context would pin a full React + Markii
 * renderer webview in memory for the entire life of the window, but this
 * extension's ENTIRE state is one string and one revision number. Instead,
 * the webview persists `{text, revision}` via `setState` on every applied
 * update and restores it from `getState()` immediately on (re)load
 * (`webview/preview.tsx`), and this function re-posts the current text
 * below whenever the panel becomes visible again (`onDidChangeViewState`)
 * — so from the user's perspective a tab switch is indistinguishable from
 * true context retention, at no standing memory cost while the panel is
 * hidden.
 */
function createPreview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  viewColumn?: vscode.ViewColumn,
): void {
  const roots = localResourceRootsFor(context, document);
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    previewTitleFor(document.uri.path),
    {
      viewColumn: viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: true,
    },
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: roots,
    },
  );

  setHtml(panel, context);

  const preview: ActivePreview = {
    panel,
    document,
    revision: 0,
    rootKeys: roots.map(rootKey),
    debouncer: createDebouncer<void>(DEBOUNCE_MS, () => {
      postUpdate(preview);
    }),
    running: false,
  };
  active = preview;
  void vscode.commands.executeCommand(
    'setContext',
    PREVIEW_ACTIVE_CONTEXT_KEY,
    true,
  );

  const disposables: vscode.Disposable[] = [
    // The ready/update handshake: the webview posts `{type: 'ready'}` once
    // its message listener has attached, and ONLY THEN do we post the first
    // `update` — a `postMessage` sent before that listener attaches would
    // otherwise be silently dropped.
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHostMessage(raw)) return;
      if (raw.type === 'ready') {
        postUpdate(preview);
      }
    }),

    // Text edits to the tracked document are debounced (matching the
    // playground's own DEBOUNCE_MS) so a fast typist doesn't flood the
    // webview with one `update` per keystroke.
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== preview.document) return;
      preview.debouncer.schedule();
    }),

    // Following the active editor is immediate, not debounced — switching
    // files should feel instant. A non-previewable editor gaining focus
    // (an Output pane, this very preview panel, a settings UI, ...) is
    // explicitly NOT switched to — the preview keeps showing whatever it
    // was already showing rather than ever going blank.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isPreviewableDocument(editor.document)) return;
      retargetPreview(context, preview, editor.document);
    }),

    // Rehydration: `retainContextWhenHidden: false` means the webview is
    // torn down while hidden and rebuilt from scratch when shown again —
    // its own `getState()`-based restore (`webview/preview.tsx`) covers the
    // instant before this arrives, and this re-post brings it fully current
    // in case anything changed while it was gone.
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        postUpdate(preview);
      }
    }),
  ];

  panel.onDidDispose(() => {
    preview.debouncer.cancel();
    for (const disposable of disposables) {
      disposable.dispose();
    }
    active = undefined;
    void vscode.commands.executeCommand(
      'setContext',
      PREVIEW_ACTIVE_CONTEXT_KEY,
      false,
    );
  });
}

/** Prompts once for a specific host, with the normative modal wording (`run/grant-flow.ts`'s `hostPromptMessage`) and the Allow / Don't allow button pair. */
async function promptHostAdapter(host: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    hostPromptMessage(host),
    { modal: true },
    ALLOW_LABEL,
    DONT_ALLOW_LABEL,
  );
  return choice === ALLOW_LABEL;
}

/** Prompts once for the "this note builds a network address dynamically" consent gate (`run/grant-flow.ts`'s `UNKNOWN_HOSTS_PROMPT_MESSAGE`). */
async function promptUnknownHostsAdapter(): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    UNKNOWN_HOSTS_PROMPT_MESSAGE,
    { modal: true },
    ALLOW_LABEL,
    DONT_ALLOW_LABEL,
  );
  return choice === ALLOW_LABEL;
}

/**
 * The `markii.runScripts` command handler: runs the currently previewed
 * document's scripts once (grant flow, then `spawnRun`) and posts the
 * outcome to the panel as a `values` message.
 *
 * A press that arrives while no preview is open, or while a previous press
 * is still running, is a no-op — see `ActivePreview.running`'s doc comment
 * for why this is "ignore", not "cancel and restart".
 *
 * The result is tagged with the revision captured BEFORE `runOnce`'s own
 * awaits (the grant prompts and the run itself can each take a while, and
 * the document may keep changing underneath) — the webview
 * (`webview/preview.tsx`) drops a `values` message whose revision no
 * longer matches what it is currently displaying.
 */
export async function runScripts(
  context: vscode.ExtensionContext,
): Promise<void> {
  const preview = active;
  if (!preview || preview.running) return;

  preview.running = true;
  const revision = preview.revision;
  const documentKey = preview.document.uri.toString();
  const text = preview.document.getText();

  try {
    const result = await runOnce({
      documentKey,
      text,
      memento: context.workspaceState,
      promptHost: promptHostAdapter,
      promptUnknownHosts: promptUnknownHostsAdapter,
      spawnRun,
      timeoutMs: RUN_TIMEOUT_MS,
    });

    const message: ValuesMessage = {
      type: 'values',
      revision,
      values: result.values,
      failures: result.failures,
    };
    void preview.panel.webview.postMessage(message);
  } finally {
    preview.running = false;
  }
}

/**
 * The `markii.openPreview` command handler. Opens a new panel for the
 * active previewable document, or — if a panel is already open — re-targets
 * and reveals it. If nothing previewable is active and no panel exists yet,
 * informs the user instead of opening an empty/blank preview.
 */
export function openPreview(context: vscode.ExtensionContext): void {
  const document = activePreviewableDocument();

  if (active) {
    if (document) {
      retargetPreview(context, active, document);
    }
    // Re-read `active`: `retargetPreview` may have replaced the panel (and
    // therefore this variable) with a freshly created one.
    const current = active;
    if (current) current.panel.reveal(current.panel.viewColumn, true);
    return;
  }

  if (!document) {
    void vscode.window.showInformationMessage(
      'Open a .mk.md (markdown) file to preview it.',
    );
    return;
  }

  createPreview(context, document);
}
