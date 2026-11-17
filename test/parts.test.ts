/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { showScore } from '../src/core/naming';
import { cleanName, splitParts } from '../src/core/parts';
import { describeView, roofLabels, type ViewClasses } from '../src/core/semantics';

const corners = (g: THREE.BufferGeometry) => Array.from(g.toNonIndexed().getAttribute('position').array);

describe('splitParts', () => {
  it('finds the connected shapes, largest surface first', () => {
    const ground = new THREE.BoxGeometry(20, 0.2, 20).translate(0, -0.1, 0);
    const house = new THREE.BoxGeometry(4, 3, 4).translate(-5, 1.5, 0);
    const bollard = new THREE.CylinderGeometry(0.3, 0.3, 1, 12).translate(4, 0.5, 2);   // stands on the ground without sharing a corner with it
    const position = [...corners(bollard), ...corners(ground), ...corners(house)];
    const { of, parts } = splitParts(position);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => Math.round(p.area))).toEqual([816, 80, 2]);
    expect(parts[2].center[0]).toBeCloseTo(4, 3);
    expect(parts[2].radius).toBeLessThan(1);
    const n = corners(bollard).length / 9;
    expect(new Set(of.slice(0, n))).toEqual(new Set([2]));           // every bollard triangle, though it came first
    expect(of.length).toBe(position.length / 9);
  });

  it('keeps a welded mesh as one shape', () => {
    expect(splitParts(corners(new THREE.BoxGeometry(1, 1, 1))).parts).toHaveLength(1);
  });
});

describe('cleanName', () => {
  it('reduces an answer to a few plain words', () => {
    expect(cleanName('Stone bollard')).toBe('stone bollard');
    expect(cleanName('The pink shape is a low garden wall.')).toBe('low garden wall');
    expect(cleanName('thinking about it...\n\nwooden barrel\n')).toBe('wooden barrel');
  });

  it('gives nothing for an answer that is not a name', () => {
    expect(cleanName('')).toBe('');
    expect(cleanName('I cannot tell what this object might be without more context about the scene')).toBe('');
  });
});

describe('showScore', () => {
  it('prefers a view that shows the shape with something around it', () => {
    expect(showScore(0.001, false)).toBe(0);                                    // too little to see
    expect(showScore(0.25, false)).toBeGreaterThan(showScore(0.05, false));
    expect(showScore(0.3, false)).toBeGreaterThan(showScore(0.95, false));      // filling the frame says nothing
    expect(showScore(0.2, false)).toBeGreaterThan(showScore(0.2, true));        // a player's view over a raised one
  });
});

describe('describeView with named shapes', () => {
  const S = 10;
  /** Left half part 0, right half part 1 (its bottom rows facing up), one pixel of part 2. */
  function view(): ViewClasses {
    const label = new Int16Array(S * S), roof = new Uint8Array(S * S), floor = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      label[i] = x < 5 ? 0 : 1;
      if (x >= 5 && y >= 6) floor[i] = 1;
    }
    label[2 * S + 2] = 2;
    return { label, roof, floor };
  }

  it('leaves unnamed shapes out and merges shapes that share a name and a place', () => {
    const c = view();
    for (let y = 0; y < S; y++) c.label[y * S + 1] = 3;        // a second "house wall" on the same side of the frame
    const d = describeView(c, ['house wall', '', 'stone bollard', 'house wall'], S);
    expect(d.parts).toBe('house wall (most of the frame), stone bollard (top left, small)');   // one entry for both walls: half the frame
  });

  it('names small props down to the size the blockout check looks at', () => {
    expect(describeView(view(), ['house wall', 'ground', 'stone bollard'], S).parts).toContain('stone bollard (top left, small)');
  });

  it('calls the up-facing part of a shell its floor', () => {
    const d = describeView(view(), ['house wall', 'plaster wall', ''], S, undefined, [false, true, false]);
    expect(d.parts).toContain('floor (bottom right)');
    expect(d.parts).toContain('plaster wall (');
    // a shell whose name already says it is walked on keeps it
    expect(describeView(view(), ['house wall', 'courtyard paving', ''], S, undefined, [false, true, false]).parts).not.toContain('floor');
  });

  it('does not read roofs out of names given to whole shapes', () => {
    expect(roofLabels(['house roof', 'ground'])).toEqual([true, false]);
    expect(roofLabels(['house roof', 'ground'], false)).toBeNull();
  });
});
