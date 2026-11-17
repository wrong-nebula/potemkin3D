import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODELS, prompts, type PromptContext } from '../src/providers/models';

const look = JSON.parse(readFileSync(new URL('../samples/luxor.look.json', import.meta.url), 'utf8'));
const base: PromptContext = { look: look.style, roofLook: '', parts: 'sandstone paving (bottom), temple wall (left), papyrus column shaft (center), seated colossus statue (right, small)',
  mode: 'first', floor: false, overcast: true };

describe('a place worded in its own terms', () => {
  it('keeps the standard wording when no setting is given', () => {
    const t = prompts.caption(base);
    expect(t).toContain('Walls may show flat details such as windows, doors, shutters and stonework');
    expect(t).toContain('market stalls');
    expect(t).toContain('soft, even overcast daylight');
  });

  it('speaks of the temple in the temple\'s terms', () => {
    const t = prompts.caption({ ...base, setting: look.setting, wording: look.wording });
    expect(t).toContain('Walls, columns, gateways and architraves may show flat details such as carved hieroglyphs');
    expect(t).toContain('open shade');
    for (const word of ['shutters', 'windows', 'market stalls', 'awnings', 'overcast']) expect(t).not.toContain(word);
    expect(t).toContain('no people, scaffolding');
    expect(t).not.toContain('statues');   // the level has a statue in view, so statues are not forbidden
    expect(prompts.caption({ ...base, parts: 'temple wall (left)', setting: look.setting })).toContain('statues');
  });

  it('fills a gap in a carved wall with more carving, not with empty plaster', () => {
    const t = prompts.caption({ ...base, mode: 'fill', plain: true, setting: look.setting });
    expect(t).toContain('the same courses of sandstone blocks, carved relief or granite');
    expect(t).toContain('carrying on its courses of blocks and its carving');
    expect(t).not.toContain('unbroken and empty');
    expect(prompts.caption({ ...base, mode: 'fill', plain: true })).toContain('unbroken and empty from edge to edge');
  });
});

describe('photos of the real place', () => {
  it('are introduced after the first image and say what to take from them', () => {
    const t = prompts.caption({ ...base, setting: look.setting, site: 3 });
    expect(t).toContain('Images 2 to 4 are photographs of the temples of Luxor in Egypt');
    expect(t).toContain('Take nothing else from them');
    expect(prompts.caption({ ...base, site: 1 })).toContain('Image 2 is a photograph of the real place this scene is built after');
    expect(prompts.caption(base)).not.toContain('photograph of');
  });

  it('push the references of earlier views further down the list', () => {
    const t = prompts.caption({ ...base, mode: 'fill', site: 2, references: 2 });
    expect(t).toContain('Images 2 to 3 are photographs');
    expect(t).toContain('Images 4 to 5 are other photos of this same place');
  });

  it('are left out of floor and roof views', () => {
    expect(prompts.caption({ ...base, mode: 'floor', floorLook: look.floorStyle, site: 3 })).not.toContain('photographs of');
  });

  it('are sent right after the view, before anything else', () => {
    const input = (key: string) => MODELS[key].input({ imageUrl: 'view', styleUrls: ['a', 'b'], refUrls: ['r'], prompt: { ...base, mode: 'fill', site: 2, references: 1 }, seed: 1, size: 1024 });
    expect(input('h3').image_urls).toEqual(['view', 'a', 'b', 'r']);
    expect(input('flux3-klein').image_urls).toEqual(['view', 'a', 'b']);
  });
});

describe('a place that is painted, not photographed', () => {
  const hangar = JSON.parse(readFileSync(new URL('../samples/hangar.look.json', import.meta.url), 'utf8'));
  const c: PromptContext = { look: hangar.style, roofLook: '', parts: 'ribbed steel wall panels (left), white police patrol robot (center)',
    mode: 'first', floor: false, indirect: true, wording: hangar.wording, setting: hangar.setting, site: 4 };

  it('asks for a frame of the film and for its references to be matched', () => {
    const t = MODELS.h3.text!(c);
    expect(t).toContain('A frame from a hand-drawn Japanese animated feature film of 1989');
    expect(t).toContain('Images 2 to 5 are frames from Patlabor');
    expect(t).toContain('This picture is a frame of the same film. Match them closely');
    expect(t).not.toMatch(/photorealistic|photographs of|what the surfaces are like/);
    expect(t).toContain('no people, characters');
    expect(t).not.toContain('characters, robots');   // a robot is in view, so robots are not forbidden
  });

  it('keeps the painting when it fills a gap', () => {
    const t = MODELS.h3.text!({ ...c, mode: 'fill', plain: true, references: 2 });
    expect(t).toContain('A frame from a hand-drawn');
    expect(t).toContain('Images 6 to 7 are other pictures of this same place');
    expect(t).toContain('the same painted steel panels, cast concrete, painted concrete or bare steel');
  });

  it('paints the ground from above as a painting too', () => {
    const t = prompts.caption({ ...c, mode: 'floor', floor: true, indirect: false, overcast: true, floorLook: hangar.floorStyle, span: 4 });   // as the ground pass asks: no sun to speak of
    expect(t).toContain('A background painting in gouache');
    expect(t).toContain('showing the ground from directly above');
    expect(t).toContain('soft, even indoor light');
    expect(t).not.toContain('A photo taken');
    expect(prompts.caption({ ...base, mode: 'floor', floor: true, floorLook: 'cobbles', span: 3 })).toContain('A photo taken from directly above');
  });

  it('can be worded the other way round: the render is a layout, the references are frames', () => {
    const t = MODELS['nano-banana-2.1'].text!({ ...c, wording: 'transfer' });
    expect(t).toContain('Image 1 is a plain gray 3D layout of a scene. Images 2 to 5 are frames from Patlabor');
    expect(t).toContain('Redraw Image 1 as one more frame of that film');
    expect(t).toContain('painted as the thing it is: ribbed steel wall panels (left), white police patrol robot (center)');
    expect(t).not.toContain('This picture is a frame of the same film');   // the frames are introduced once, not again after
    const fill = MODELS.h3.text!({ ...c, wording: 'production', mode: 'fill', references: 1 });
    expect(fill).toContain('本編カット');
    expect(fill).toContain(hangar.setting.title);
    expect(fill).toContain('only partly painted');
    expect(fill).toContain('Everything already painted stays exactly as it is');
    expect(fill).toContain('Image 6 is another picture of this same place');
    // without a painted wording the model keeps its instruction prompt
    expect(MODELS['nano-banana-2.1'].text!({ ...base, mode: 'first' })).toContain('Turn this untextured gray 3D render');
  });
});
