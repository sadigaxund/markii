import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { renderMark } from '@markii/react';
import { defaultRegistry } from '@markii/react/components';
import { extractScripts, parse } from '@markii/core';
import { createValueStore, runDocumentScripts } from '@markii/runtime';
import type { RunSummary } from '@markii/runtime';
import { createLuaExecutor } from '@markii/lua';
import {
  createFetchNetProvider,
  createMemoryCacheProvider,
  DEMO_NET_GRANTS,
} from './script-host';
import { highlightPreviewCodeBlocks } from './code-highlight';
// Vite `?url` asset import: ships wasmoon's `glue.wasm` as a hashed file in
// this app's own build output and resolves to that local URL at runtime,
// instead of `@markii/lua`'s default (unconfigured) browser behavior of
// fetching it from `https://unpkg.com/wasmoon@<version>/dist/glue.wasm` —
// see `@markii/lua`'s `createEmptyLuaEngine`/`RunScriptOptions` doc comments
// for why that CDN default exists and why a host would want to avoid it.
// `*?url` is typed by `vite/client` (already in this app's `tsconfig.json`).
import wasmUrl from 'wasmoon/dist/glue.wasm?url';
import { CodeEditor } from './CodeEditor';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';
import { getParseStatus } from './parse-status';
import { DEMO_DOC } from './demo-doc';

const DEBOUNCE_MS = 200;

/**
 * The Lua executor closes over one fixed capability configuration for the
 * whole session: a real `fetch`-backed `NetProvider`, the demo's GET grant
 * (`api.github.com`), and an in-memory `CacheProvider`. Built once at
 * module scope (not per render/run) — matching how `@markii/lua`'s
 * `LuaExecutorConfig` doc comment describes it: "captured once and reused
 * for every script the returned executor runs".
 *
 * SECURITY NOTE (spec §10): this executor runs wasmoon **on the main
 * thread**. Per docs/security.md, a real host MUST run note scripts in a
 * dedicated, terminatable Web Worker with an EXTERNAL wall-clock watchdog
 * that calls `terminate()` — in-VM limits alone cannot guarantee a hostile
 * or hung script can be stopped. Running on the main thread here is
 * acceptable ONLY because this is a dev harness executing the *author's
 * own* trusted demo script, not a host rendering untrusted notes. Do not
 * copy this pattern into a production renderer.
 */
const luaExecutor = createLuaExecutor({
  net: createFetchNetProvider(),
  netGrants: DEMO_NET_GRANTS,
  cache: createMemoryCacheProvider(),
  // Local bundled asset (see the `wasmUrl` import above) — keeps this dev
  // harness offline-capable instead of depending on the unpkg CDN at
  // script-run time.
  wasmUri: wasmUrl,
});

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; summary: RunSummary };

function statusLine(runState: RunState): string {
  switch (runState.phase) {
    case 'idle':
      return 'not yet run — values below are missing until you click Run';
    case 'running':
      return 'running…';
    case 'done': {
      const { summary } = runState;
      const parts = summary.results.map((entry) =>
        entry.status === 'fresh'
          ? `${entry.name}: fresh`
          : `${entry.name}: error (${entry.error ?? 'unknown error'})`,
      );
      return `${summary.freshCount} fresh, ${summary.errorCount} error${
        summary.errorCount === 1 ? '' : 's'
      } — ${parts.join('; ')}`;
    }
  }
}

/**
 * The GitHub "octocat" mark, inlined as a single hand-written `<path>`.
 *
 * Deliberately NOT an icon-library dependency: this repo's self-built-component
 * rule (AGENTS.md) applies to the apps too, and one 16×16 glyph does not
 * justify a package. `fill="currentColor"` lets the link's `color` (and its
 * hover transition) drive the icon, so there is no second palette to keep in
 * sync with `styles.css`. `aria-hidden` because the surrounding anchor already
 * carries the accessible name.
 */
function GitHubMark(): ReactElement {
  return (
    <svg
      className="playground__repo-link-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function App(): ReactElement {
  const [source, setSource] = useState(DEMO_DOC);
  const [debounced, setDebounced] = useState(DEMO_DOC);
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' });
  // The value store is a mutable, note-scoped object per docs/scripting.md — it
  // must persist for the life of the session (one store, created once),
  // never rebuilt per render, or a run's results would vanish on the next
  // keystroke. `useRef` (not `useState`) because the store's identity never
  // needs to change and mutating it in place must NOT itself trigger a
  // render — `renderVersion` below is the explicit signal for that.
  const storeRef = useRef(createValueStore());
  // The store is mutated in place by `runDocumentScripts`, so React has no
  // way to detect that new values are available — this counter is bumped
  // after a run completes purely to force the preview to re-render and pick
  // up the new store contents.
  const [renderVersion, setRenderVersion] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(source);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source]);

  const parseStatus = useMemo(() => getParseStatus(debounced), [debounced]);

  const handleRun = useCallback(async (): Promise<void> => {
    setRunState({ phase: 'running' });
    const scripts = extractScripts(parse(source));
    const summary = await runDocumentScripts({
      scripts,
      executor: luaExecutor,
      trigger: 'manual',
      store: storeRef.current,
    });
    setRunState({ phase: 'done', summary });
    setRenderVersion((v) => v + 1);
  }, [source]);

  const isRunning = runState.phase === 'running';
  // `renderVersion` has no meaningful value of its own — it is included
  // purely so this memo recomputes after a run mutates `storeRef.current`
  // in place (see the doc comment above `renderVersion`'s declaration).
  // Bumped once per `preview` recomputation, purely to give `.doc` below a
  // fresh `key` each time (see the effect after `preview`'s declaration).
  const previewKeyRef = useRef(0);
  const preview = useMemo(() => {
    previewKeyRef.current += 1;
    return renderMark(debounced, defaultRegistry, storeRef.current);
  }, [debounced, renderVersion]);

  // Playground-only syntax highlighting for rendered code blocks (issue #5).
  // `@markii/react` never re-highlights a fence itself (see `ScriptMarker`'s
  // doc comment), so this walks the committed preview DOM and decorates it
  // in place. It must run against a genuinely fresh subtree every time —
  // mutating `innerHTML` under a node React still plans to reconcile against
  // would leave stale spans behind after the next edit — which is exactly
  // what the `key` on `.doc` below (bumped whenever `preview` itself changes)
  // guarantees: React fully remounts the subtree instead of diffing it.
  const docRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (docRef.current) highlightPreviewCodeBlocks(docRef.current);
  }, [preview]);

  return (
    <div className="playground">
      <header className="playground__header">
        <div className="playground__header-text">
          <h1>Markii Playground</h1>
          <p>
            A thin harness for viewing .mk.md source next to its rendered
            output.
          </p>
        </div>
        {/*
          The label is hidden by CSS on narrow viewports (the link collapses to
          the icon), so the accessible name lives on `aria-label` and does not
          depend on it — while still containing the visible word "GitHub"
          (WCAG 2.5.3 label-in-name).
        */}
        <a
          className="playground__button playground__button--ghost playground__repo-link"
          href="https://github.com/sadigaxund/markii"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Markii on GitHub"
        >
          <GitHubMark />
          <span className="playground__repo-link-label">GitHub</span>
        </a>
      </header>
      <main className="playground__panes">
        <section className="playground__pane">
          <h2 className="playground__pane-title">Source</h2>
          <CodeEditor
            className="playground__editor"
            value={source}
            onChange={setSource}
          />
        </section>
        <section className="playground__pane">
          <div className="playground__pane-title playground__pane-title--row">
            <span>Preview</span>
            <button
              type="button"
              className="playground__button playground__button--primary"
              onClick={() => void handleRun()}
              disabled={isRunning}
            >
              {isRunning ? 'Running…' : 'Run scripts'}
            </button>
          </div>
          <div className="playground__preview">
            <PreviewErrorBoundary resetKey={debounced}>
              <div className="doc" key={previewKeyRef.current} ref={docRef}>
                {preview}
              </div>
            </PreviewErrorBoundary>
          </div>
          <p className="playground__scripting-status">{statusLine(runState)}</p>
          <p className="playground__status-bar">
            {parseStatus.ok
              ? `ok — ${parseStatus.directiveCount} directive${parseStatus.directiveCount === 1 ? '' : 's'} found`
              : `parse error — ${parseStatus.error}`}
          </p>
        </section>
      </main>
      <footer className="playground__footnote">
        Values are cached in the value store; rendering never runs scripts —
        only clicking Run does. Demo runs scripts on the main thread for
        simplicity; a production host must run them in a terminatable Web Worker
        with an external watchdog (docs/security.md).
      </footer>
    </div>
  );
}
