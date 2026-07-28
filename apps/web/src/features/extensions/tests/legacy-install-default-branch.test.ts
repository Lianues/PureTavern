import { afterEach, describe, expect, it } from 'vitest';

import {
  applyLegacyExtensionInstallDefaultBranch,
  installLegacyExtensionInstallDefaultBranch,
} from '../legacy/install-default-branch';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.innerHTML = '';
});

describe('Legacy extension install default branch', () => {
  it('fills an existing empty branch input with main without overwriting a custom value', () => {
    document.body.innerHTML = `
      <input type="text" id="extension_branch_name">
      <div><input type="text" id="unrelated_input" value=""></div>
    `;
    const branch = document.querySelector<HTMLInputElement>('#extension_branch_name');

    applyLegacyExtensionInstallDefaultBranch(document);

    expect(branch?.value).toBe('main');
    expect(branch?.dataset.pureTavernDefaultBranchApplied).toBe('true');
    expect(document.querySelector<HTMLInputElement>('#unrelated_input')?.value).toBe('');

    document.body.innerHTML = '<input type="text" id="extension_branch_name" value="dev">';
    const customBranch = document.querySelector<HTMLInputElement>('#extension_branch_name');
    applyLegacyExtensionInstallDefaultBranch(document);
    expect(customBranch?.value).toBe('dev');
  });

  it('fills branch inputs added by the popup after the hook is installed', async () => {
    disposers.push(installLegacyExtensionInstallDefaultBranch());
    const popup = document.createElement('div');
    popup.innerHTML = '<input type="text" id="extension_branch_name">';
    document.body.append(popup);
    await flushMutationObserver();

    expect(popup.querySelector<HTMLInputElement>('#extension_branch_name')?.value).toBe('main');
  });

  it('does not refill the input after the user clears it', async () => {
    disposers.push(installLegacyExtensionInstallDefaultBranch());
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'extension_branch_name';
    document.body.append(input);
    await flushMutationObserver();
    expect(input.value).toBe('main');

    input.value = '';
    input.remove();
    document.body.append(input);
    await flushMutationObserver();

    expect(input.value).toBe('');
  });
});

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
