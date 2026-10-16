import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { generateMap, recipeOf } from '../game/maps/generator';
import { renderMapPreview } from '../game/maps/preview';
import { MapPreview, previewDataUrl } from './MapPreview';

describe('MapPreview', () => {
  const image = renderMapPreview(generateMap(recipeOf('winter', 99)).layout);

  it('is a labelled image with the pixel hash, 128 px for a 4 px preview and 64 px for a thumbnail', () => {
    const html = renderToStaticMarkup(<MapPreview image={image} label="Preview of a map" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Preview of a map"');
    expect(html).toContain('width="128"');
    expect(html).toContain(`data-preview-hash="${image.hash}"`);
    const small = renderMapPreview(generateMap(recipeOf('winter', 99)).layout, { cellPx: 2 });
    expect(renderToStaticMarkup(<MapPreview image={small} label="x" />)).toContain('width="64"');
  });

  it('keeps its frame when there is no image', () => {
    const html = renderToStaticMarkup(<MapPreview image={null} label="No preview" />);
    expect(html).toContain('width="128"');
    expect(html).toContain('data-empty');
    expect(html).not.toContain('data-preview-hash');
  });

  it('gives no data URL where there is no canvas (Node)', () => {
    expect(previewDataUrl(image)).toBeNull();
  });
});
