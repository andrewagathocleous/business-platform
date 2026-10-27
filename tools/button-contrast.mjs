/** WCAG 2.x relative luminance and contrast. No dependencies. */

export function parseCssColor(input) {
  const match = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(
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

export function composite(foreground, background) {
  const a = foreground.a;
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
    a: 1,
  };
}

function channel(value) {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * `layers` are background colours from the element outward.
 * Walk until the first fully opaque layer, compositing partial alphas on the way.
 * A missing background is white, matching the page canvas.
 */
export function effectiveBackground(layers) {
  const stack = [];
  for (const layer of layers) {
    if (!layer || layer.a <= 0) {
      continue;
    }
    stack.push(layer);
    if (layer.a >= 1) {
      break;
    }
  }
  let result = { r: 255, g: 255, b: 255, a: 1 };
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const layer = stack[index];
    result = layer.a >= 1 ? { r: layer.r, g: layer.g, b: layer.b, a: 1 } : composite(layer, result);
  }
  return result;
}

/**
 * Paint `text` and `buttonBackground` at `opacity` over `behind` (the background outside the faded element).
 * Returns the colours a reader actually sees, then their contrast.
 */
export function paintedContrast(text, buttonBackground, behind, opacity) {
  const button = composite({ ...buttonBackground, a: buttonBackground.a * opacity }, behind);
  const paintedText = composite({ ...text, a: text.a * opacity }, button);
  return contrastRatio(paintedText, button);
}
