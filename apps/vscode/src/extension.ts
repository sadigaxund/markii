import * as vscode from 'vscode';
import { openPreview, resetScriptGrants, runScripts } from './preview-panel.js';

/**
 * Extension entry point. Imports `vscode` — deliberately NOT unit-tested
 * (vitest cannot resolve `vscode`); this file is wiring only, registering
 * the three commands `package.json`'s `contributes.commands` declares
 * (`markii.openPreview`, `markii.runScripts`, `markii.resetScriptGrants`)
 * and delegating all actual behavior to `preview-panel.ts`.
 */
export function activate(context: vscode.ExtensionContext): void {
  const openPreviewCommand = vscode.commands.registerCommand(
    'markii.openPreview',
    () => {
      openPreview(context);
    },
  );
  const runScriptsCommand = vscode.commands.registerCommand(
    'markii.runScripts',
    () => {
      void runScripts(context);
    },
  );
  const resetScriptGrantsCommand = vscode.commands.registerCommand(
    'markii.resetScriptGrants',
    () => {
      void resetScriptGrants(context);
    },
  );
  context.subscriptions.push(
    openPreviewCommand,
    runScriptsCommand,
    resetScriptGrantsCommand,
  );
}

export function deactivate(): void {}
