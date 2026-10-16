import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { WorldRenderer } from './WorldRenderer';

const layerOf = (renderer: WorldRenderer): Container =>
  (renderer as unknown as { hintLayer: Container }).hintLayer;

describe('classic renderer hint markers', () => {
  it('draws one Graphics for any number of cells, and draws nothing for an empty list', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.setHintMarkers([]);
    expect(layerOf(renderer).children).toHaveLength(0);
    renderer.setHintMarkers([{ cells: [{ x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 }] }]);
    expect(layerOf(renderer).children).toHaveLength(1);
    expect(layerOf(renderer).children[0]).toBeInstanceOf(Graphics);
  });

  it('does not leak children when set repeatedly, and clears when switched off', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    for (let index = 0; index < 4; index += 1) renderer.setHintMarkers([{ cells: [{ x: index, y: 1 }] }]);
    expect(layerOf(renderer).children).toHaveLength(1);
    renderer.setHintMarkers([]);
    expect(layerOf(renderer).children).toHaveLength(0);
  });

  it('clears the marker when a new park is installed', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.setHintMarkers([{ cells: [{ x: 4, y: 5 }] }]);
    renderer.setSession(new ParkSession(null));
    expect(layerOf(renderer).children).toHaveLength(0);
  });
});
