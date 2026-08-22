import * as vscode from 'vscode';
import { openPreview, runScripts } from './preview-panel.js';

/**
 * Extension entry point. Imports `vscode` — deliberately NOT unit-tested
 * (vitest cannot resolve `vscode`); this file is wiring only, registering
 * the two commands `package.json`'s `contributes.commands` declares
 * (`markii.openPreview`, `markii.runScripts`) and delegating all actual
 * behavior to `preview-panel.ts`.
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
  context.subscriptions.push(openPreviewCommand, runScriptsCommand);
}

export function deactivate(): void {}
