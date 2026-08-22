import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import { renderMark } from '@markii/react';
import { defaultRegistry } from '@markii/react/components';
import { createValueStore } from '@markii/runtime';
import type { StoredValue } from '@markii/runtime';
import { isHostToWebviewMessage, isNewerRevision } from '../protocol.js';
import type { WebviewToHostMessage } from '../protocol.js';
import { applyDocumentBase } from './document-images.js';
import {
  getPersistedState,
  getVsCodeApi,
  setPersistedState,
} from './vscode-api.js';
import type { PersistedState } from './vscode-api.js';

interface PreviewErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value clears a caught error and re-tries rendering `children` — `Preview` passes the current `revision`, so a fixed/updated document is given a fresh chance instead of the crash message sticking forever. */
  resetKey: unknown;
}

interface PreviewErrorBoundaryState {
  hasError: boolean;
}

/**
 * Belt-and-suspenders around `renderMark`, mirroring
 * `apps/playground/src/PreviewErrorBoundary.tsx`: `renderMark` already
 * never throws (it catches internally), but a registered component's own
 * render function can still throw once React actually mounts/updates the
 * element tree, outside `renderMark`'s synchronous try/catch.
 *
 * Wording is QUIET, unlike the playground's boundary (AGENTS.md's
 * cleanliness principle: the rendered page shows quiet markers, never error
 * dumps or machinery) — one short sentence, no stack, no error message on
 * screen. The detail goes to `console.error` only, reachable via the
 * webview's own "Open Webview Developer Tools" command for anyone who needs
 * it.
 */
export class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PreviewErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      'Markii preview failed to render:',
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prevProps: PreviewErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <p className="mk-preview__error" role="alert">
          This document could not be previewed.
        </p>
      );
    }
    return this.props.children;
  }
}

const READY_MESSAGE: WebviewToHostMessage = { type: 'ready' };

/**
 * One `values` message's contents, tagged with the text revision it was
 * computed against. Kept separate from the run's `failures` array — every
 * per-script failure a component needs to branch on is already embedded in
 * its own `StoredValue.failureKind` (`@markii/runtime`'s store), so nothing
 * here needs to thread `failures` through to rendering; it exists on the
 * wire only for a future host-side use (e.g. a status-bar summary).
 */
interface RunValues {
  readonly revision: number;
  readonly values: Record<string, StoredValue>;
}

/** This component's full local state: the persisted `{text, revision,
 * baseUri}` (`vscode-api.ts`'s `PersistedState`, unchanged) plus the
 * latest run output, NOT persisted — see `runValues`'s own doc comment on
 * why hiding/recreating the webview simply drops it rather than round-
 * tripping run results through `setState`.
 */
interface LocalState extends PersistedState {
  readonly runValues?: RunValues;
}

function initialState(): LocalState {
  return getPersistedState() ?? { text: '', revision: 0 };
}

/**
 * The webview's root component. Holds `{text, revision, baseUri}` (plus,
 * separately, the last run's output) in state, seeded on mount from
 * whatever was last persisted via `setState` (`vscode-api.ts`) so a
 * hidden/recreated webview (this extension runs with
 * `retainContextWhenHidden: false` — see `preview-panel.ts`) rehydrates
 * instantly instead of flashing empty before the host's re-post arrives.
 *
 * On mount it posts `{type: 'ready'}` exactly once — the handshake
 * `preview-panel.ts` waits for before sending the first `update`, so the
 * very first `postMessage` can never be dropped for arriving before this
 * component's message listener has attached.
 *
 * Rendering feeds `renderMark` a value store built from the most recent
 * `values` message THAT STILL MATCHES THE CURRENT TEXT REVISION — see
 * `store`'s own comment. With no matching run yet, `renderMark` gets no
 * store at all: script blocks show the renderer's collapsed marker and
 * data-bound components show their standard empty states, exactly as
 * before `markii.runScripts` existed.
 */
export function Preview(): ReactElement {
  const [state, setState] = useState<LocalState>(initialState);
  const documentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Mount-only: this handshake happens exactly once per webview instance.
    getVsCodeApi().postMessage(READY_MESSAGE);
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>): void {
      const data = event.data;
      if (!isHostToWebviewMessage(data)) return;
      setState((previous) => {
        if (data.type === 'update') {
          if (!isNewerRevision(previous.revision, data.revision)) {
            return previous;
          }
          return {
            text: data.text,
            revision: data.revision,
            baseUri: data.baseUri,
            // A run's output is tied to the revision it ran against; a
            // fresh `update` can never match that revision again (revision
            // numbers only increase), so there's nothing to carry forward.
            runValues: undefined,
          };
        }
        // A `values` result for anything other than the CURRENT text
        // revision is stale — e.g. the document kept changing while the
        // run was in flight — and is dropped rather than applied.
        if (data.revision !== previous.revision) return previous;
        return {
          ...previous,
          runValues: { revision: data.revision, values: data.values },
        };
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Persistence is an EFFECT, never a side effect inside the `setState`
  // updater above: React may invoke an updater more than once for the same
  // transition (StrictMode does so deliberately), and an updater that writes
  // to the outside world is not a pure function of its previous state. Here
  // it runs once per applied state, which is exactly the rehydration
  // contract `preview-panel.ts` documents. Only the `PersistedState` fields
  // are written back out — `runValues` is deliberately not part of the
  // persisted shape (see `LocalState`'s doc comment).
  useEffect(() => {
    setPersistedState({
      text: state.text,
      revision: state.revision,
      baseUri: state.baseUri,
    });
  }, [state.text, state.revision, state.baseUri]);

  // Only a run whose revision still matches the CURRENTLY DISPLAYED text
  // counts — this is the other half of the stale-revision drop above (that
  // one guards what gets ACCEPTED into state; this guards what gets USED,
  // in case `runValues` from a since-superseded revision were ever still
  // sitting in state).
  const store = useMemo(() => {
    if (!state.runValues || state.runValues.revision !== state.revision) {
      return undefined;
    }
    return createValueStore(state.runValues.values);
  }, [state.runValues, state.revision]);

  const rendered = useMemo(
    () => renderMark(state.text, defaultRegistry, store),
    [state.text, store],
  );

  // Relative image sources are resolved against the document's folder AFTER
  // each render, in the DOM, rather than anywhere inside the renderer — see
  // `document-images.ts` for why that boundary is where it is. Re-runs
  // whenever the rendered tree or the folder changes.
  useEffect(() => {
    const container = documentRef.current;
    if (container) {
      applyDocumentBase(container, state.baseUri);
    }
  }, [rendered, state.baseUri]);

  return (
    <PreviewErrorBoundary resetKey={state.revision}>
      {/*
        `key` is the base URI so that switching to a document in a DIFFERENT
        folder remounts the tree instead of letting React reuse an `<img>`
        whose `src` prop is unchanged (`nice.png` in both documents) — a
        reused element keeps the absolute URL the effect above already wrote
        into it, which would point at the OLD folder. Remounting restores the
        relative source, and the effect re-resolves it against the new base.
      */}
      <div className="doc" ref={documentRef} key={state.baseUri ?? ''}>
        {rendered}
      </div>
    </PreviewErrorBoundary>
  );
}
