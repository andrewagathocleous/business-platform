import { expect, type Page } from '@playwright/test';
import { waitForSettledPaint } from './settle-paint';

/**
 * Every visible button needs an accessible name, painted text, and contrast of
 * at least 4.5:1 between that text and the first opaque background. A disabled
 * button's background must differ from an enabled primary button on the same page.
 */
export async function assertButtonContrast(page: Page): Promise<void> {
  await waitForSettledPaint(page);
  const failures: string[] = await page.evaluate(async () => {
    type Rgb = { r: number; g: number; b: number; a: number };

    function parseCssColor(input: string): Rgb | null {
      const match =
        /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(
          input.trim(),
        );
      if (!match) {
        return null;
      }
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = match[4] === undefined ? 1 : Number(match[4]);
      if ([r, g, b, a].some((value) => Number.isNaN(value))) {
        return null;
      }
      return { r, g, b, a };
    }

    function composite(foreground: Rgb, background: Rgb): Rgb {
      const alpha = foreground.a;
      return {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
        a: 1,
      };
    }

    function channel(value: number): number {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }

    function relativeLuminance(color: Rgb): number {
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    }

    function contrastRatio(foreground: Rgb, background: Rgb): number {
      const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
      const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    }

    function effectiveBackground(layers: Rgb[]): Rgb {
      const stack: Rgb[] = [];
      for (const layer of layers) {
        if (layer.a <= 0) {
          continue;
        }
        stack.push(layer);
        if (layer.a >= 1) {
          break;
        }
      }
      let result: Rgb = { r: 255, g: 255, b: 255, a: 1 };
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const layer = stack[index];
        if (!layer) {
          continue;
        }
        result =
          layer.a >= 1 ? { r: layer.r, g: layer.g, b: layer.b, a: 1 } : composite(layer, result);
      }
      return result;
    }

    function paintedContrast(
      text: Rgb,
      buttonBackground: Rgb,
      behind: Rgb,
      opacity: number,
    ): number {
      const button = composite({ ...buttonBackground, a: buttonBackground.a * opacity }, behind);
      const paintedText = composite({ ...text, a: text.a * opacity }, button);
      return contrastRatio(paintedText, button);
    }

    function clipped(element: Element): boolean {
      const style = getComputedStyle(element);
      return style.position === 'absolute' && (style.width === '1px' || style.height === '1px');
    }

    function painted(element: Element): boolean {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || clipped(current)) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    }

    function visibleText(element: Element): string {
      let text = '';
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? '';
          continue;
        }
        if (node instanceof Element && painted(node)) {
          text += ` ${visibleText(node)}`;
        }
      }
      return text.replace(/\s+/g, ' ').trim();
    }

    function accessibleName(button: HTMLButtonElement): string {
      const labelledBy = button.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 0) {
          return text;
        }
      }
      const label = button.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim() ?? '';
      if (label.length > 0) {
        return label;
      }
      return visibleText(button);
    }

    function textElement(button: HTMLButtonElement): HTMLElement | null {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        const own = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (parent && own.length > 0 && painted(parent)) {
          return parent;
        }
        node = walker.nextNode();
      }
      return null;
    }

    function isDisabled(button: HTMLButtonElement): boolean {
      return (
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.dataset['pDisabled'] === 'true'
      );
    }

    function buttonBackground(button: HTMLButtonElement): Rgb | null {
      const layers: Rgb[] = [];
      let current: Element | null = button;
      while (current) {
        const background = parseCssColor(getComputedStyle(current).backgroundColor);
        if (background && background.a > 0) {
          layers.push(background);
          if (background.a >= 1) {
            break;
          }
        }
        current = current.parentElement;
      }
      return layers.length > 0 ? effectiveBackground(layers) : null;
    }

    function sameColor(left: Rgb, right: Rgb): boolean {
      return (
        Math.round(left.r) === Math.round(right.r) &&
        Math.round(left.g) === Math.round(right.g) &&
        Math.round(left.b) === Math.round(right.b)
      );
    }

    function isVisible(element: HTMLElement): boolean {
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      const rects = element.getClientRects();
      return rects.length > 0 && (rects[0]?.width ?? 0) > 0 && (rects[0]?.height ?? 0) > 0;
    }

    const problems: string[] = [];
    for (const button of document.querySelectorAll('button')) {
      if (!(button instanceof HTMLButtonElement) || !isVisible(button)) {
        continue;
      }
      const name = accessibleName(button);
      const textNode = textElement(button);
      const text = textNode ? visibleText(button) : '';
      if (name.length === 0 || text.length === 0 || !textNode) {
        problems.push(`blank button accessible="${name}" text="${text}"`);
        continue;
      }
      const textColor = parseCssColor(getComputedStyle(textNode).color);
      const layers: Rgb[] = [];
      let current: Element | null = textNode;
      let opaque: Element | null = null;
      while (current) {
        const background = parseCssColor(getComputedStyle(current).backgroundColor);
        if (background && background.a > 0) {
          layers.push(background);
          if (background.a >= 1) {
            opaque = current;
            break;
          }
        }
        current = current.parentElement;
      }
      if (!textColor || layers.length === 0) {
        problems.push(`unreadable colour on "${text}"`);
        continue;
      }
      const background = effectiveBackground(layers);
      const behindSource = opaque?.parentElement
        ? parseCssColor(getComputedStyle(opaque.parentElement).backgroundColor)
        : null;
      const behind =
        behindSource && behindSource.a > 0 ? behindSource : { r: 244, g: 246, b: 248, a: 1 };
      let opacity = 1;
      let faded: Element | null = textNode;
      while (faded) {
        opacity *= Number(getComputedStyle(faded).opacity);
        if (faded === opaque) {
          break;
        }
        faded = faded.parentElement;
      }
      const ratio = paintedContrast(textColor, background, behind, opacity);
      const disabled = isDisabled(button);
      if (ratio < 4.5) {
        problems.push(
          `${disabled ? 'disabled ' : ''}"${text}" contrast ${ratio.toFixed(2)} < 4.5 (${name})`,
        );
      }
    }

    function nextFrame(): Promise<void> {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }

    let changingPrimary = false;
    let primaryBackground: Rgb | null = null;
    for (const button of document.querySelectorAll('button')) {
      if (!(button instanceof HTMLButtonElement) || !isVisible(button) || isDisabled(button)) {
        continue;
      }
      const severity = button.getAttribute('data-p-severity');
      const primary =
        button.classList.contains('p-button') &&
        (severity === null || severity.length === 0 || severity === 'primary');
      if (!primary) {
        continue;
      }
      const first = getComputedStyle(button).backgroundColor;
      await nextFrame();
      await nextFrame();
      if (getComputedStyle(button).backgroundColor !== first) {
        changingPrimary = true;
        continue;
      }
      const stable = buttonBackground(button);
      if (stable) {
        primaryBackground = stable;
        break;
      }
    }
    if (!primaryBackground && changingPrimary) {
      problems.push('enabled primary button background was still changing');
    }
    if (primaryBackground) {
      for (const button of document.querySelectorAll('button')) {
        if (!(button instanceof HTMLButtonElement) || !isVisible(button) || !isDisabled(button)) {
          continue;
        }
        const background = buttonBackground(button);
        const label = accessibleName(button);
        if (background && sameColor(background, primaryBackground)) {
          problems.push(`disabled "${label}" background matches the enabled primary button`);
        }
      }
    }
    return problems;
  });
  expect(failures).toEqual([]);
}
