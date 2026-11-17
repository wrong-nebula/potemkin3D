import type { FloorDetailSpec } from '../core/floor-detail';

// Bundled, lazily loaded assets: this renderer does not depend on the experiment server or FAL.
export const SENTO_FLOOR = {
  model: new URL('../assets/sento-floor/hall.glb', import.meta.url).href,
  paint: new URL('../assets/sento-floor/paint.jpg', import.meta.url).href,
  detail: {
    label: 'tiled bathhouse floor', layoutHash: 'cbde5eb2',
    packedUrl: new URL('../assets/sento-floor/packed.png', import.meta.url).href,
    protectUrl: new URL('../assets/sento-floor/protect.png', import.meta.url).href,
    statisticsUrl: new URL('../assets/sento-floor/statistics.png', import.meta.url).href,
    regions: 169, spanMetres: 1, heightMetres: .002, sourceAtlasSize: 2048,
  } satisfies FloorDetailSpec,
};
