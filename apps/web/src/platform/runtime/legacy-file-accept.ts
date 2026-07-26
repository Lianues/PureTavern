/**
 * 放宽移动端文件选择器的 accept 过滤。
 *
 * Legacy 页面用扩展名写 accept（例如聊天导入的 `.json, .jsonl`）。桌面浏览器直接按扩展名
 * 过滤，没有问题；但 Android / iOS 的系统选择器只认 MIME：浏览器先把扩展名翻译成 MIME 再
 * 发给系统，`.jsonl`、`.charx`、`.byaf`、`.lorebook`、`.settings` 这些没有 MIME 映射的扩展名
 * 会被直接丢掉，于是手机上只剩 `.json` 可选，jsonl 聊天记录是灰的、点不动。
 *
 * 所以在移动端把「含扩展名的 accept」整体放宽成任意文件，让系统选择器把文件都列出来。
 * 纯 MIME 的 accept（如头像的 `image/*`）保持原样，避免破坏相机 / 相册入口。
 * 放宽只影响选择器的过滤，选中之后 Legacy 自身仍按扩展名校验并给出原有提示。
 */

const EXTENSION_TOKEN = /^\.[a-z\d][\w.+-]*$/iu;
const ANY_FILE = '*/*';

/** 返回放宽后的 accept；无需改动时返回 null。 */
export function relaxFileAccept(accept: string): string | null {
  const tokens = accept
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.includes(ANY_FILE)) return null;
  if (!tokens.some((token) => EXTENSION_TOKEN.test(token))) return null;
  return ANY_FILE;
}

/** 当前环境的文件选择器是否按 MIME 过滤（移动端外壳与移动浏览器）。 */
export function usesMimeOnlyFilePicker(
  navigatorLike: Navigator | undefined = globalThis.navigator,
): boolean {
  if (!navigatorLike) return false;
  const userAgent = navigatorLike.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony|ArkWeb/iu.test(userAgent)) return true;
  // iPadOS 13 起默认伪装成 Macintosh，只能靠触点数区分。
  return /Macintosh/iu.test(userAgent) && (navigatorLike.maxTouchPoints ?? 0) > 1;
}

export interface LegacyFileAcceptOptions {
  /** 覆盖平台判定，测试与排查时使用。 */
  enabled?: boolean;
}

export function installLegacyFileAccept(options: LegacyFileAcceptOptions = {}): () => void {
  const enabled = options.enabled ?? usesMimeOnlyFilePicker();
  if (!enabled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }

  const apply = (root: Document | Element) => {
    for (const element of selectFileInputs(root)) relaxElement(element);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) relaxElement(record.target);
      for (const node of record.addedNodes) {
        if (node instanceof Element) apply(node);
      }
    }
  });
  apply(document);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['accept', 'type'],
  });

  // 有些入口（如助手聊天导入）临时 createElement 一个 input 直接 click，从不插进 DOM，
  // MutationObserver 看不到，只能在打开选择器前兜底一次。
  const originalClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function patchedClick(this: HTMLInputElement) {
    relaxElement(this);
    return originalClick.call(this);
  };

  return () => {
    observer.disconnect();
    HTMLInputElement.prototype.click = originalClick;
  };
}

function relaxElement(element: Element): void {
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') return;
  const accept = element.getAttribute('accept');
  if (accept === null) return;
  const relaxed = relaxFileAccept(accept);
  if (relaxed === null || relaxed === accept) return;
  element.dataset.pureTavernUpstreamAccept ??= accept;
  element.setAttribute('accept', relaxed);
}

function selectFileInputs(root: Document | Element): Element[] {
  const selector = 'input[type="file"][accept]';
  const elements = Array.from(root.querySelectorAll(selector));
  if (root instanceof Element && root.matches(selector)) elements.unshift(root);
  return elements;
}
