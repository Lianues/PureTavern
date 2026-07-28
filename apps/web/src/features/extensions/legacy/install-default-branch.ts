const BRANCH_INPUT_SELECTOR = 'input#extension_branch_name';
const DEFAULT_EXTENSION_BRANCH = 'main';

/**
 * 为原版动态创建的扩展安装弹窗填入稳定的默认分支。
 *
 * 只在输入框第一次出现且仍为空时写入，用户随后修改或清空的值不会被再次覆盖。
 */
export function applyLegacyExtensionInstallDefaultBranch(root: Document | Element): void {
  for (const element of selectBranchInputs(root)) {
    if (!(element instanceof HTMLInputElement)) continue;
    if (element.dataset.pureTavernDefaultBranchApplied === 'true') continue;

    element.dataset.pureTavernDefaultBranchApplied = 'true';
    if (!element.value.trim()) element.value = DEFAULT_EXTENSION_BRANCH;
  }
}

/** 在不修改 Legacy 上游源码的前提下增强扩展安装弹窗。 */
export function installLegacyExtensionInstallDefaultBranch(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) applyLegacyExtensionInstallDefaultBranch(node);
      }
    }
  });

  applyLegacyExtensionInstallDefaultBranch(document);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function selectBranchInputs(root: Document | Element): Element[] {
  const elements = Array.from(root.querySelectorAll(BRANCH_INPUT_SELECTOR));
  if (root instanceof Element && root.matches(BRANCH_INPUT_SELECTOR)) elements.unshift(root);
  return elements;
}
