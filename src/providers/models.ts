/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
/**
 * Image-edit models the pipeline can call, with what each accepts. Prices are fal's listed per-image prices
 * (token-priced models estimated). Defaults come from the spike (spike/README.md): FLUX 3 Klein keeps the
 * camera and geometry for first views; Fibo 2 with a mask gives the cleanest fills.
 */
export interface EditInput {
  imageUrl: string;
  maskUrl?: string;
  /** A sheet of material samples from the texture so far (core/swatches.ts), for models that take a second image. */
  swatchUrl?: string;
  /** Earlier views that look at the place this view is to paint (core/references.ts), for models that take several images. */
  refUrls?: string[];
  /** Photos of the real place the level is built after (PipelineOptions.styleImages), sent right after the view. */
  styleUrls?: string[];
  prompt: PromptContext;
  seed: number;
  size: number;
}

export interface EditModel {
  key: string;
  label: string;
  endpoint: string;
  /** null: no mask input; 'white'/'black': which mask colour means "paint here". */
  mask: null | 'white' | 'black';
  /** Price of one image at 1024 px. */
  price: number;
  /** Price of one image at another size, for a model that is charged by size. */
  priceAt?(size: number): number;
  /**
   * The most pixels along a side the model really paints. A larger view still comes back at the view's size, but
   * scaled up, with no more detail. Unset: it paints at whatever size is asked.
   */
  nativeSize?: number;
  /** The most reference pictures of the place the model is sent with a view that fills gaps; unset: none. */
  maxRefs?: number;
  /** The most photos of the real place the model is sent with a view (PipelineOptions.styleImages); unset: none. */
  maxStyle?: number;
  /** What each picture sent beside the view adds to a call's price, for a model charged by its input. */
  imagePrice?: number;
  /** The model carries out notes drawn onto the render it is sent, and leaves none of the writing (core/notes.ts). */
  readsNotes?: boolean;
  /** The prompt this model is sent, when it is not one of the two standard wordings as they are. */
  text?(c: PromptContext): string;
  input(i: EditInput): Record<string, unknown>;
}

/** The share of a view's pixels along a side that a model fills with real detail (1 unless it paints smaller and scales up). */
export const detailOf = (m: EditModel, size: number) => (m.nativeSize ? Math.min(1, m.nativeSize / size) : 1);

/** What one image from a model costs at a view size. */
export const priceOf = (m: EditModel, size: number) => m.priceAt?.(size) ?? m.price;

/** What one view asks for. Built per view from the labelled geometry (core/semantics.ts). */
export interface PromptContext {
  /** Materials only, never objects: whatever a prompt names, the models paint somewhere. */
  look: string;
  /** Roof material for roof passes. */
  roofLook: string;
  /** Parts of the level in the area to paint with rough positions; '' when the level has no part names. */
  parts: string;
  /**
   * first: nothing painted in view yet; fill: continue the texture around the gaps; roof: paint roofs only;
   * floor: paint the ground only, in a view straight down at it.
   */
  mode: 'first' | 'fill' | 'roof' | 'floor';
  /** For floor views: what the ground is made of, how many metres of it the image shows across, and whether some
   *  of it is already painted in view. */
  floorLook?: string;
  span?: number;
  context?: boolean;
  /** For a ground tile: the second image is a still of the ground as the level's views painted it, to match. */
  reference?: boolean;
  /** For a ground tile made from another (core/ground.ts): the state this tile shows the same stretch of ground in. */
  variant?: string;
  /** The area to paint is mostly ground. */
  floor: boolean;
  /**
   * A view that only fills gaps (hole and clean-up passes): the gray areas are more of the surfaces beside them. Such
   * a view stands close and sees no whole wall, so a window it invents comes out at its own scale, doll-sized.
   */
  plain?: boolean;
  /**
   * How the picture is described to a caption-style model. Unset: a photorealistic photo. 'photo': a documentary
   * photograph with its lens and aperture; 'aaa': a next gen AAA game texture pass; 'scout': an unedited
   * location-scouting photo, the most subdued of those tried (lowest contrast and saturation, fewest blown highlights);
   * 'retro': a screenshot from a mid-2000s first-person shooter, the kind whose textures were photographs of real
   * buildings (the era's look described in general terms: no game is named and none is copied); 'remaster': that
   * same grounded, run-down look as a game of today would draw it (scanned materials, traced light);
   * 'survey': a record photograph from an archaeological survey, for a ruin or a monument (even light, true colours,
   * the carving legible); 'cel': not a photo at all but a frame from a hand-drawn animated film of 1989 (a gouache
   * background, machines drawn as cels), for a place built after such a film; its references are frames to match.
   * Two more for such a place, worded another way round (see filmCaption): 'transfer' says the render is a layout and
   * the references are frames, and asks for one more frame; 'production' says the same in the film's own production
   * vocabulary, in Japanese first (layout, background art in poster colour, cels).
   */
  wording?: 'photo' | 'aaa' | 'scout' | 'retro' | 'remaster' | 'survey' | 'cel' | 'transfer' | 'production';
  /** How the place is worded, when it is not a town of plastered houses (see PromptSetting). */
  setting?: PromptSetting;
  /** How many photos of the real place come with the view, right after the first image (Images 2 to n + 1). */
  site?: number;
  /**
   * Paint the colour of the surfaces only (a diffuse, or albedo, pass): no shadows, no darkening in corners, no
   * highlights, so that normal, roughness and occlusion maps can be laid over it without shading baked in twice.
   */
  diffuse?: boolean;
  /** How many reference pictures of the place come with the view, after the first image (and the sample sheet, if any). */
  references?: number;
  /**
   * Notes drawn in red onto the render this view is sent (core/notes.ts): their words, for the prompt to know what
   * they ask for. The prompt then says to carry them out and leave no trace of the writing.
   */
  notes?: string;
  /** The sun is out but does not shine into view (Lighting.indirect): bright, indirect daylight with no sun patches. */
  indirect?: boolean;
  /** Painting under overcast light (no cast shadows wanted) rather than keeping the render's sun and shadows. */
  overcast?: boolean;
  /** A second image comes along: a sheet of material samples from the same level, to match. */
  swatches?: boolean;
  /**
   * The area to paint is shapes the model painted over before (it carried a wall or the paving across them): say
   * that each is a part of its own.
   */
  shapes?: boolean;
  /** Discrete standalone object mode (prop, weapon, character, vehicle) rather than an architectural room or street. */
  object?: boolean;
}

/**
 * How a kind of place is worded. The standard wording was written on a village and a loft: it lets walls show
 * windows, doors and shutters, forbids awnings and market stalls, and calls bare surfaces masonry, plaster or
 * concrete. A temple, a cave or a spaceship needs its own words for the same three things, or the model is invited
 * to put shutters on a pylon. Every field replaces the standard wording for that one thing.
 */
export interface PromptSetting {
  /** What the place is called where the photos of it are introduced: 'the temples of Luxor'. */
  place?: string;
  /** For a film: its title as written where it was made, for the 'production' wording: '『機動警察パトレイバー the Movie』'. */
  title?: string;
  /** Which surfaces may carry flat detail: 'Walls' by default; 'Walls, columns and gateways'. */
  carriers?: string;
  /** The flat detail they may carry: 'windows, doors, shutters and stonework' by default. */
  details?: string;
  /** Things the models like to add to such a place; listed as forbidden unless the level models them. */
  additions?: string[];
  /** The bare materials a gap is filled with: 'masonry, plaster, concrete, metal or wood' by default. */
  materials?: string;
  /**
   * How a filled gap continues its surface: 'unbroken and empty from edge to edge' by default, which is right for
   * plaster and wrong for a wall carved all over ('carrying on its courses of blocks and its carving').
   */
  fill?: string;
  /** What the ground is when it is to stay clear: 'bare paving' by default. */
  ground?: string;
  /** The light, when painting without cast shadows, in this place's terms; 'soft, even overcast daylight...' by default. */
  light?: string;
}

/** Things the models like to add to a street scene; listed as forbidden unless the level models them. */
const ADDITIONS = ['awnings', 'market stalls', 'shop fronts', 'signs', 'lamps', 'plants', 'crates', 'barrels',
  'benches', 'furniture', 'people', 'cars'];

function forbidden(parts: string, additions = ADDITIONS) {
  const have = new Set(parts.toLowerCase().split(/[^a-z]+/).map((w) => w.replace(/s$/, '')));
  return additions.filter((a) => !a.split(' ').some((w) => have.has(w.replace(/s$/, '')))).join(', ');
}

/** Things a wall has that a gap-filling view must not add: a look's clauses that name one are left out of its prompt. */
const OPENINGS = /\b(doors?|doorways?|shutters?|windows?|gates?|arch(es|ways?)?|balcon(y|ies)|shop ?fronts?)\b/i;

/** A look without its clauses (between commas or semicolons) about doors, shutters, windows and the like. */
export function bareLook(look: string): string {
  const colon = look.indexOf(':');
  const head = colon >= 0 ? look.slice(0, colon + 1) : '', rest = colon >= 0 ? look.slice(colon + 1) : look;
  const kept = rest.split(/[,;]/).map((s) => s.trim()).filter((s) => s && !OPENINGS.test(s));
  return kept.length ? `${head}${head ? ' ' : ''}${kept.join(', ')}` : look;
}

const metres = (c: PromptContext) => Math.max(1, Math.round(c.span ?? 7));
const shapes = (c: PromptContext) => (c.parts ? `: ${c.parts}` : '');
/** What to make of the sample sheet, when one is sent as the second image. */
const samples = (c: PromptContext) => (c.swatches
  ? ' The second image is a sheet of material samples cut from other surfaces of the same place: its plaster, stonework, ' +
    'woodwork and paving. Use these same materials and colours. It is not a view of the scene: take nothing of its arrangement.'
  : '');
/** How the light should look: the render's own sun and shadows, or soft overcast light with no cast shadows. */
/** How a colour-only picture is described: what worked on MiniMax H3 (wall shading followed the render's light half as much). */
const DIFFUSE = "pure surface colour only, as a game engine shows a scene in its unlit base-colour view. There is no lighting in it at " +
  'all: no shadows, no darkening in corners, joints or under ledges, no ambient occlusion, no highlights, no reflections, no gradients ' +
  "from light. Every surface shows the flat, even colour of its material, with all of the material's own detail: each stone, crack, " +
  'stain and grain';
/** What the picture is, for the wordings other than the standard one (and for the diffuse pass). */
const picture = (c: PromptContext, look: string) => (c.diffuse
  ? `The diffuse (albedo, base colour) texture pass of ${look}: ${DIFFUSE}`
  : c.wording === 'aaa'
    ? `A next gen AAA game texture pass: ${look}. Next gen AAA game texture quality throughout: photogrammetry-scanned materials, rich ` +
      `physically based surface detail, crisp at every distance, with ${light(c)}`
    : c.wording === 'remaster'
      ? `A screenshot from a first-person game released this year, running at its highest settings on current hardware: ${look}. ` +
        'It returns to the grounded, run-down realism of the shooters of the mid-2000s, with their muted, slightly desaturated palette ' +
        'of ochre, grey and faded green, and draws it as games are drawn now: every material scanned from the real thing, with fine ' +
        'relief, chipped edges, layered dirt and wear that follows how the place was used; light traced as it really bounces, with ' +
        `${light(c)}, soft colour bleeding from the floor onto the walls and deep, clean contact shadows. Clear air, no haze, no lens ` +
        'effects. No people, no weapon in hand, no interface or text overlay'
    : c.wording === 'retro'
      ? `A screenshot from a first-person shooter of 2004, running on the PC hardware of that year: ${look}. The world is built from ` +
        'photographs of real, run-down buildings: every surface carries a photo-sourced texture at the modest resolution of the time, ' +
        `flat and matte, with no reflections and no fine relief, and the scene has soft baked lighting with ${light(c)}. A muted, ` +
        'slightly desaturated palette of ochre, grey and faded green; grime and water stains where the walls meet the floor. No ' +
        'people, no weapon in hand, no interface or text overlay'
    : c.wording === 'survey'
      ? `A record photograph from an archaeological survey, taken to document a monument as it stands: ${look}. Everything is in ` +
        `sharp focus and in true colours, the stone and its carving plainly legible, with ${light(c)}. Neutral exposure, no colour ` +
        'grading, no dramatic contrast'
    : c.wording === 'cel'
      ? 'A frame from a hand-drawn Japanese animated feature film of 1989, a grounded near-future police story with working ' +
        `robots, in a shot with no characters in it: ${look}. The setting is a background painting in gouache, realistic, ` +
        'exact and restrained, in muted, slightly greyed colours, with thin, even ink lines along its edges and seams and soft, ' +
        'flat shapes of shadow. The machines and vehicles in it are drawn as animation cels laid over that painting: clean flat ' +
        `colour, one hard-edged tone of shadow and a thin black outline. It has ${light(c)}. It is painted by hand, not a ` +
        'photograph and not a 3D render: no photographic texture, no film grain, no gloss, no lens effects. No characters and no people'
    : c.wording === 'scout'
      ? `An unedited location-scouting photo of ${look}, straight out of the camera, with ${light(c)}. Neutral exposure, low contrast, ` +
        'muted natural colours, no colour grading'
      : `A documentary photograph of ${look}, taken on a full-frame camera with a 24 mm lens at f/8, everything in sharp focus, natural ` +
        `colours, with ${light(c)}`);
const styled = (c: PromptContext) => !!c.diffuse || !!c.wording;
const light = (c: PromptContext) => (c.diffuse ? 'no lighting or shading of any kind' : c.indirect
  ? 'bright, indirect daylight: the sun is out but does not shine in, so there are no sunbeams, no sunlit patches on the floor or walls ' +
    'and no hard shadows, only soft, even light and gentle shading'
  : c.overcast
  ? c.setting?.light ?? 'soft, even overcast daylight with no cast shadows and no sunlit patches'
  : 'the same light direction and shadows');
const surfaces = (c: PromptContext) => c.object
  ? `Every part of the object keeps its exact silhouette, edges and proportions; ${c.notes ? 'apart from what the notes ask for, nothing new is added' : 'nothing is added around or behind the object'}: no people, text, labels, pedestals or background scenery.`
  : `${c.setting?.carriers ?? 'Walls'} may show flat details such as ${c.setting?.details ?? 'windows, doors, shutters and stonework'}, but nothing sticks out of them and ` +
    `${c.notes ? 'apart from what the notes ask for, nothing new is added' : 'nothing new is added'}: no ${forbidden(`${c.parts} ${c.notes ?? ''}`, c.setting?.additions)}.` +
    (c.floor ? ` The ground stays clear: ${c.setting?.ground ?? 'bare paving'}.` : '');
/** The bare materials a gap is filled with, and how the fill continues its surface. */
const bare = (c: PromptContext) => c.setting?.materials ?? 'masonry, plaster, concrete, metal or wood';
const unbroken = (c: PromptContext) => c.setting?.fill ?? 'unbroken and empty from edge to edge';

/**
 * What a view is told about the photos of the real place that come with it. They are for what the surfaces are like
 * and nothing else: a model shown a photo of a place likes to hand that photo back, so the sentence ends on what
 * the picture keeps.
 */
function site(c: PromptContext): string {
  const n = c.site ?? 0;
  if (!n || c.mode === 'floor' || c.mode === 'roof') return '';
  const one = n === 1, cel = isPainted(c.wording);
  return ` ${one ? `Image 2 is a ${cel ? 'frame' : 'photograph'}` : `Images 2 to ${n + 1} are ${cel ? 'frames' : 'photographs'}`} ${cel ? 'from' : 'of'} ${c.setting?.place ?? 'the real place this scene is built after'}. ` +
    (cel
      // a film's look is the whole of its frames: this picture is to pass for one more of them
      ? `This picture is a frame of the same film. Match ${one ? 'it' : 'them'} closely: the palette, the line, how light and shadow are ` +
        `painted, and give every wall, deck, machine and fitting it shows the design its like has in ${one ? 'that frame' : 'those frames'}. ` +
        `Take nothing else from ${one ? 'it' : 'them'}: not the camera or composition, and none of the people in ${one ? 'it' : 'them'}. `
      : `Take from ${one ? 'it' : 'them'} what the surfaces are like: the material and its colour, how it is cut and jointed, the style, size and ` +
        `depth of its detail, its wear. Take nothing else from ${one ? 'it' : 'them'}: not the camera or composition, not the sunlight, shadows or sky, ` +
        `and none of the people or things in ${one ? 'it' : 'them'}. `) +
    'The picture keeps exactly the camera and the shapes of the first image.';
}

/** The wordings of a place that is painted, not photographed: a frame of a hand-drawn film. */
export const isPainted = (wording?: string) => wording === 'cel' || wording === 'transfer' || wording === 'production';

/**
 * The 'transfer' and 'production' wordings: the caption turned round. The other wordings describe the finished
 * picture and add that it keeps the first image's shapes; these say what the first image is (a gray layout, or a
 * frame only partly painted), what the others are (frames of the film) and what to do (make one more frame). On single
 * hangar views this got a model that reads references well much closer to the film than describing the picture did.
 */
function filmCaption(c: PromptContext): string {
  const n = c.site ?? 0, jp = c.wording === 'production';
  const film = c.setting?.place ?? 'a hand-drawn animated film of 1989';
  const frames = n ? ` ${n === 1 ? 'Image 2 is a frame' : `Images 2 to ${n + 1} are frames`} from ${film}.` : '';
  const style = `${n ? 'Copy the look of the frames as closely as you can' : 'Its look is that of the film'}: the backgrounds painted by hand in poster colour with ` +
    'visible brushwork, in muted, slightly greyed colours; the machines and vehicles drawn as cels, with thin black lines, flat paint and a single tone ' +
    `of shadow; the slight softness and grain of 35 mm film. It has ${light(c)}.`;
  const taken = n ? ` Take nothing else from the frames: none of their people, none of their composition.` : ' No people.';
  if (c.mode === 'first') {
    return (jp
      ? `1989年公開の劇場用アニメ映画${c.setting?.title ?? ''}の本編カット。Image 1 はこのカットのレイアウト（グレーの3D下絵）。レイアウトのカメラ、パース、すべての形をそのまま保ち、` +
        '背景美術（ポスターカラーによる手描きの背景）とセル画（メカ）で仕上げる。背景は筆のタッチが見える写実的で緻密な描き込み、くすんだ色、壁の汚れや雨だれ、' +
        'ステンシルの番号。メカと車両はセル塗り：細い黒の主線、ベタ塗り、影色は一段。35mmフィルムの柔らかさと粒状感。人物は描かない。 In English: '
      : '') +
      `Image 1 is a plain gray 3D layout of a scene.${frames} Redraw Image 1 as one more frame of that film: ${c.look}. Keep exactly the camera, the ` +
      `perspective and every shape of Image 1: each gray shape keeps its outline and is painted as the thing it is${shapes(c)}. ${style} ${surfaces(c)}${taken}`;
  }
  const rest = c.shapes
    ? `the plain gray shapes are solid parts of the scene, each painted with a surface of its own and a visible edge where it meets its surroundings, keeping its exact outline${shapes(c)}`
    : c.plain
      ? `every plain gray surface is painted as more of the surface that borders it, in that surface's own bare material (the same ${bare(c)}), ${unbroken(c)}, keeping its exact outline${shapes(c)}`
      : `the plain gray surfaces are painted to continue what is around them seamlessly, each keeping its exact outline${shapes(c)}`;
  return (jp
    ? `1989年公開の劇場用アニメ映画${c.setting?.title ?? ''}の本編カット。Image 1 は途中まで仕上がったカットで、グレーのまま残っている部分はまだレイアウト（3D下絵）。` +
      '仕上がっている部分は一切変えず、グレーの部分だけを同じ背景美術（ポスターカラーの手描き）とセル画（メカ）で描き足す。人物は描かない。 In English: '
    : '') +
    `Image 1 is a frame of ${jp ? 'that film' : film} that is only partly painted: parts of it are still the plain gray 3D layout.` +
    `${n ? ` ${n === 1 ? 'Image 2 is a finished frame' : `Images 2 to ${n + 1} are finished frames`} from ${film}.` : ''} Finish it: ${c.plain ? bareLook(c.look) : c.look}. ` +
    `Everything already painted stays exactly as it is, in camera, composition and every detail; ${rest}. ${style}${c.plain && !c.shapes ? '' : ` ${surfaces(c)}`}${taken}`;
}

/** How a picture of the ground from straight above opens: a photo, or a painting where the place is painted ('cel'). */
const above = (c: PromptContext) => (isPainted(c.wording)
  ? 'A background painting in gouache from a hand-drawn animated film of 1989, showing the ground from directly above, the view pointing straight down at it'
  : 'A photo taken from directly above, the camera pointing straight down at the ground');
const painted = (c: PromptContext) => (isPainted(c.wording)
  ? ' It is painted by hand: flat, matte colour with soft, brushed variation and a few thin ink lines, with no photographic texture and no grain.'
  : '');

/** What a view that carries notes is told about them: the wording that worked on MiniMax H3 (three notes of three carried out, no red left). */
const NOTES = ' The first image carries a few notes in red: handwriting on white labels, with red outlines, lines and arrows. They are an ' +
  "art director's instructions and not part of the scene. Carry out each note exactly at the place it marks, at the size its outline " +
  'gives, painted as a real thing in the scene. Then leave no trace of the notes themselves: no red writing, no labels, no outlines, no arrows.';

/** What a view is told about the reference pictures that come with it (the wording tried on MiniMax H3 hole views). */
function references(c: PromptContext): string {
  const n = c.references ?? 0;
  if (!n) return '';
  const from = 2 + (c.site ?? 0) + (c.swatches ? 1 : 0), one = n === 1;
  const pic = isPainted(c.wording) ? 'picture' : 'photo';   // a painted place has pictures of it, not photos
  return ` ${one ? `Image ${from} is another ${pic}` : `Images ${from} to ${from + n - 1} are other ${pic}s`} of this same place, ${pic === 'photo' ? 'taken' : 'seen'} from ` +
    `${one ? 'another spot' : 'other spots'}. Where a gray area of the first image shows something ${one ? `that ${pic} shows` : `those ${pic}s show`}, ` +
    `paint it as it looks ${one ? 'there' : 'in them'}: the same material, colours and detail. Take nothing of ${one ? 'its' : 'their'} camera or composition.`;
}

/** What a reference picture adds to a call's price with MiniMax H3 (about 5,400 image tokens). */
export const REFERENCE_PRICE = 0.008;

/**
 * The prompt for a note on ground that is already painted (Session.groundNotes): the picture is the ground from
 * straight above, and only what the note asks for changes.
 */
export const groundNotePrompt = (look: string) =>
  `A photo taken from directly above, the camera pointing straight down at the ground: ${look}, flat, with soft, even overcast daylight ` +
  'and no cast shadows. It is identical to Image 1 in framing and in everything it shows, stone for stone. Only what the note asks ' +
  `for is changed, as something that is really there in the ground, seen from above.${numbered(NOTES)}`;

/**
 * The prompt for a prop's turnaround sheet (Session.propPass): up to four pictures of the place in a grid, the prop
 * gray in each, to be painted as one object seen from so many sides.
 */
export const propSheetPrompt = (name: string, sides: number, look: string, film?: { frames: number; place?: string; cel?: boolean }) => (film
  // a painted place ('cel'): the sheet is frames of the film. A machine is drawn as the film draws its machines, a cel
  // laid over the background (`cel`, the default); a thing that never moves is part of the painted background. The
  // frames that come with it (Images 2 on) say what such things look like there
  ? `Image 1 is a sheet of ${sides} frames from a hand-drawn animated film, all of the same place, in a grid: ${look}. Each shows the same ` +
    `plain gray untextured object from a different side: it is a ${name}. Paint that gray object in every frame as the very same ${name}, ` +
    (film.cel === false
      ? 'painted as the film paints its backgrounds: in gouache, realistic and restrained, in muted, slightly greyed colours, with thin, even ' +
        'ink lines along its edges and seams and soft, flat shapes of shadow, '
      : 'drawn as the film draws its machines: clean flat colour, one hard-edged tone of shadow and a thin dark outline, with its panel lines, ' +
        'hatches, vents and small markings, ') +
    'so that what one frame shows of it agrees with what the next shows. It keeps its exact outline in ' +
    'every frame. Everything else in each frame stays exactly as it is, and the frames stay exactly where they are in the grid.' +
    (film.frames ? ` ${film.frames === 1 ? 'Image 2 is a frame' : `Images 2 to ${film.frames + 1} are frames`} from ${film.place ?? 'the same film'} ` +
      (film.cel === false
        ? `that ${film.frames === 1 ? 'shows' : 'show'} how the film paints such places: give the object their palette, line and wear. `
        : `that ${film.frames === 1 ? 'shows' : 'show'} how its machines look: give the object their design, colours and markings. `) +
      `Take nothing else from ${film.frames === 1 ? 'it' : 'them'}, and no people.` : '')
  : `Image 1 is a sheet of ${sides} photos of the same place, in a grid: ${look}. Each shows the same plain gray untextured object from a ` +
  `different side: it is a ${name}. Paint that gray object in every photo as the very same ${name}: one real object photographed from ` +
  `${sides} sides, with the same material, the same colours, the same marks and details, so that what one photo shows of it agrees with ` +
  'what the next shows, and in the materials and light of the place around it. It keeps its exact outline in every photo. Everything ' +
  'else in each photo stays exactly as it is, and the photos stay exactly where they are in the grid.');

export const prompts = {
  /** Instruction-style (Fibo, Ideogram, Nano Banana, FLUX 3). */
  instruction(c: PromptContext): string {
    if (c.mode === 'floor') {
      return `Paint the masked gray ground as ${c.floorLook}, seen from directly above: the camera points straight down, ` +
        `and the image shows about ${metres(c)} metres of ground from edge to edge. The ground is flat and fills the masked area` +
        `${c.context ? ', continuing the textured ground around it seamlessly with detail of the same size and colour' : ''}, ` +
        `with ${light(c)}. Paint nothing outside the mask, and add nothing standing or lying on the ground.`;
    }
    if (c.mode === 'roof') {
      return `Paint the masked roof surfaces as ${c.roofLook}. Follow each roof's exact outline and slope, with ` +
        `${light(c)}. Paint nothing outside the mask, and add nothing on the roofs: no ` +
        'chimneys, antennas, windows, solar panels or plants.';
    }
    if (c.mode === 'first') {
      return `Turn this untextured gray 3D render into a photorealistic photo of ${c.look}. Every gray shape keeps ` +
        `its exact outline and becomes the real surface it is${shapes(c)}. Keep exactly the same camera, ` +
        `perspective and edges, with ${light(c)}, and give the surfaces realistic materials. ${surfaces(c)}`;
    }
    if (c.shapes) {
      return `Paint the masked gray shapes with photorealistic materials of ${c.look}. Each masked shape is a solid part ` +
        'of the scene with exactly this outline, standing apart from what is behind and beside it: give it a surface of ' +
        'its own, with a visible edge where it meets its surroundings, and do not continue the wall or the ground across ' +
        `it. Keep every edge and the perspective exactly as they are, with ${light(c)}.` +
        `${c.parts ? ` The masked area shows: ${c.parts}.` : ''} ${surfaces(c)}`;
    }
    if (c.plain) {
      return `Paint the masked gray surfaces with photorealistic materials of ${bareLook(c.look)}, as more of the surfaces that ` +
        `border them, each in its own bare material (the same ${bare(c)}), ${unbroken(c)}` +
        `. Keep every edge and the perspective exactly as they are, with ${light(c)}.` +
        `${c.parts ? ` The masked area shows: ${c.parts}.` : ''}`;
    }
    return `Paint the masked gray surfaces with photorealistic materials of ${c.look}, continuing the textured ` +
      `surfaces around them seamlessly. Keep every edge and the perspective exactly as they are, with ${light(c)}.` +
      `${c.parts ? ` The masked area shows: ${c.parts}.` : ''} ${surfaces(c)}`;
  },
  /** Caption-style (FLUX 3 Klein, which edits without a mask and is told what the result looks like). */
  caption(c: PromptContext): string {
    // the film wordings say what the frames are themselves, in their own order: no `site` sentence after them
    if ((c.wording === 'transfer' || c.wording === 'production') && (c.mode === 'first' || c.mode === 'fill')) {
      return filmCaption(c) + (c.mode === 'fill' ? references(c) : '') + (c.notes ? NOTES : '');
    }
    return prompts.captionBody(c) + site(c) + (c.mode === 'fill' ? references(c) : '') + (c.notes && c.mode !== 'floor' && c.mode !== 'roof' ? NOTES : '');
  },
  captionBody(c: PromptContext): string {
    if (c.mode === 'floor' && c.variant !== undefined) {
      return `${above(c)}: ${c.floorLook}, flat, ` +
        `with ${light(c)}.${painted(c)} It is the very same stretch of ground as the first image, with exactly its framing: every stone, slab, ` +
        `board, joint and crack is where it is in the first image, with the same size and outline. Only its state differs: ${c.variant}. ` +
        'There is no horizon and no sky, and nothing stands or lies on the ground.';
    }
    if (c.mode === 'floor') {
      return `${above(c)}: ${c.floorLook}, flat, ` +
        `with ${light(c)}.${painted(c)} It has exactly the framing of the first image, which shows about ${metres(c)} metres of ground from ` +
        'edge to edge' + (c.context
        ? ', and is identical to it in every area that already has texture: the plain gray ground of the first image now ' +
          'continues that ground seamlessly, with detail of the same size and colour.'
        : ': the plain gray ground of the first image is now this ground.') +
        ' There is no horizon and no sky, and nothing stands or lies on the ground.' + (c.reference
        ? ' The second image shows this very ground from eye height, among the walls around it: paint that same ground, with stones (or ' +
          'slabs, or boards) of the same shape, the same colours and the same joints, now seen from straight above. Take only the ground ' +
          'from it: no walls, no objects, and none of its perspective.'
        : '');
    }
    if (c.mode === 'roof') {
      return `A photo identical to the first image, except that its plain gray roofs are now ${c.roofLook}, following each ` +
        `roof's exact outline and slope, with ${light(c)}; nothing is added on the roofs.`;
    }
    if (c.mode === 'first' && styled(c)) {
      return `${picture(c, c.look)}. It has exactly the camera, perspective and composition of the first image, and every gray ` +
        `shape of the first image keeps its exact outline and is now the real surface it is${shapes(c)}. ${surfaces(c)}${samples(c)}`;
    }
    if (c.mode === 'first') {
      return `A photorealistic photo of ${c.look}, with exactly the camera, perspective and composition of the first ` +
        `image and ${light(c)}. Every gray shape of the first image keeps its exact outline and is now the real ` +
        `surface it is${shapes(c)}. ${surfaces(c)}${samples(c)}`;
    }
    if (c.plain && !c.shapes) {
      // Nothing here names a thing to paint, not even to forbid it: whatever a caption names, the model paints. So the
      // look is given without its clauses about doors, shutters and windows.
      return `${styled(c) ? `${picture(c, bareLook(c.look))}. It is` : `A photorealistic photo of ${bareLook(c.look)}, with ${light(c)},`} identical to the first image in camera, ` +
        'perspective, composition and in every area that already has texture. Every plain gray untextured surface of the first ' +
        `image is now painted as more of the surface that borders it, in that surface's own bare material (the same ${bare(c)}; ` +
        `the same paving or floor on the ground), ${unbroken(c)}, in the same colours ` +
        'and with detail of the same size. ' +
        `No gray is left, and the outlines stay exactly as they are${shapes(c)}.`;
    }
    return `${styled(c) ? `${picture(c, c.look)}. It is` : `A photorealistic photo of ${c.look}, with ${light(c)},`} ` +
      'identical to the first image in camera, perspective, ' +
      'composition and in every area that already has texture; the plain gray untextured ' + (c.shapes
      ? 'shapes of the first image are solid parts of the scene, each with a surface of its own and a visible edge where ' +
        `it meets its surroundings, and keep their exact outlines${shapes(c)}. ${surfaces(c)}`
      : `surfaces of the first image now continue those textures seamlessly and keep their exact outlines${shapes(c)}. ${surfaces(c)}`) + samples(c);
  },
};

const size = (s: number) => ({ width: s, height: s });
/** The captions speak of the first and second image; H3 is told to call its inputs Image 1, Image 2. */
const numbered = (text: string) => text.replace(/\bthe first image\b/gi, 'Image 1').replace(/\bthe second image\b/gi, 'Image 2');

export const MODELS: Record<string, EditModel> = {
  'flux3-klein': {
    key: 'flux3-klein', label: 'FLUX 3 Klein', endpoint: 'blackforestlabs/flux-3/klein/edit-image', mask: null, price: 0.009, maxStyle: 3,
    // fal's list: $0.008 at 768 px, $0.009 at 1K, $0.011 at 1.5K, $0.014 at 2K, $0.036 at 4K
    priceAt: (s) => (s <= 768 ? 0.008 : s <= 1024 ? 0.009 : s <= 1536 ? 0.011 : s <= 2048 ? 0.014 : 0.036),
    input: (i) => ({ prompt: prompts.caption(i.prompt), image_urls: [i.imageUrl, ...(i.styleUrls ?? []), ...((i.prompt.swatches || i.prompt.reference) && i.swatchUrl ? [i.swatchUrl] : [])],
      image_size: size(i.size), seed: i.seed, output_format: 'png', enable_prompt_expansion: false, num_images: 1 }),
  },
  // MiniMax H3 Image: no mask and no seed (the same call twice gives two different paintings), up to 16 input images
  // and 20 megapixels out. Charged by tokens: $1.50 per million of input image (5,122 for one image at any size),
  // $2.30 per million of text (its own expansion of the prompt, about 5,000), $3.80 per million of output image (4,096
  // at 2048 px, 16,384 at 4096 px). Measured: $0.034 a view at 2048 px in 27 s, $0.082 at 4096 px in 45 to 65 s.
  'h3': {
    key: 'h3', label: 'MiniMax H3 Image', endpoint: 'minimax/h3-image/edit', mask: null, price: 0.023, readsNotes: true, maxRefs: 3, maxStyle: 4, imagePrice: 0.008,
    priceAt: (s) => (s <= 1024 ? 0.023 : s <= 2048 ? 0.034 : 0.082),   // 1024 px: worked out from the token rates, not measured
    text: (c) => numbered(prompts.caption(c)),
    input: (i) => ({ prompt: numbered(prompts.caption(i.prompt)), image_urls: [i.imageUrl, ...(i.styleUrls ?? []), ...((i.prompt.swatches || i.prompt.reference) && i.swatchUrl ? [i.swatchUrl] : []), ...(i.refUrls ?? [])],
      image_size: size(i.size), output_format: 'png', num_images: 1 }),
  },
  'h3-fast': {
    // the same model served faster at twice the token rates; not yet tried here
    key: 'h3-fast', label: 'MiniMax H3 Image Highspeed', endpoint: 'minimax/h3-image/highspeed/edit', mask: null, price: 0.046, readsNotes: true, maxRefs: 3, maxStyle: 4, imagePrice: 0.016,
    priceAt: (s) => (s <= 1024 ? 0.046 : s <= 2048 ? 0.068 : 0.164),
    text: (c) => numbered(prompts.caption(c)),
    input: (i) => ({ prompt: numbered(prompts.caption(i.prompt)), image_urls: [i.imageUrl, ...(i.styleUrls ?? []), ...((i.prompt.swatches || i.prompt.reference) && i.swatchUrl ? [i.swatchUrl] : []), ...(i.refUrls ?? [])],
      image_size: size(i.size), output_format: 'png', num_images: 1 }),
  },
  'fibo2': {
    key: 'fibo2', label: 'Fibo 2 Edit', endpoint: 'bria/fibo-2/edit', mask: 'white', price: 0.04, nativeSize: 1024,
    input: (i) => ({ instruction: prompts.instruction(i.prompt), image_urls: [i.imageUrl],
      seed: i.seed, ...(i.maskUrl && i.prompt.mode !== 'first' ? { mask_url: i.maskUrl } : {}) }),
  },
  'ideogram-4.5': {
    key: 'ideogram-4.5', label: 'Ideogram 4.5', endpoint: 'ideogram/v4.5/edit', mask: 'black', price: 0.06,
    input: (i) => ({ image_url: i.imageUrl, prompt: prompts.instruction(i.prompt), quality: 'medium',
      seed: i.seed, num_images: 1, edit_precision: i.prompt.mode === 'first' ? 'regular' : 'high',
      ...(i.maskUrl && i.prompt.mode !== 'first' ? { mask_url: i.maskUrl } : {}) }),
  },
  'nano-banana-2.1': {
    // charged by tokens: about $0.05 at 1K by the list; 2K is asked for from 2048 px views up (price there taken as twice that, not measured)
    key: 'nano-banana-2.1', label: 'Nano Banana 2.1', endpoint: 'google/nano-banana-2.1/edit', mask: null, price: 0.05, maxStyle: 4, maxRefs: 3,
    priceAt: (s) => (s <= 1024 ? 0.05 : s <= 2048 ? 0.1 : 0.2),   // a prop's turnaround sheet is 4096 px: asked for at 4K
    // an instruction model; for a painted place (isPainted) it is sent the caption wording and the film's frames, as the caption models are
    text: (c) => (isPainted(c.wording) ? numbered(prompts.caption(c)) : prompts.instruction(c)),
    input: (i) => ({ prompt: isPainted(i.prompt.wording) ? numbered(prompts.caption(i.prompt)) : prompts.instruction(i.prompt),
      image_urls: [i.imageUrl, ...(i.styleUrls ?? []), ...(i.refUrls ?? [])],
      resolution: i.size > 2048 ? '4K' : i.size > 1024 ? '2K' : '1K', aspect_ratio: '1:1', seed: i.seed, output_format: 'png', num_images: 1 }),
  },

  'flux3': {
    key: 'flux3', label: 'FLUX 3', endpoint: 'blackforestlabs/flux-3/edit-image', mask: null, price: 0.048,
    input: (i) => ({ prompt: prompts.instruction(i.prompt), image_urls: [i.imageUrl],
      aspect_ratio: '1:1', resolution: '1k', output_format: 'png', enable_prompt_expansion: false }),
  },
};

/**
 * Material estimation for the baked texture (core/pbr.ts): PATINA predicts normal and roughness maps from an image
 * of at most 2048 px a side. fal lists it per megapixel.
 */
export const MATERIAL_MODEL = { key: 'patina', label: 'PATINA', endpoint: 'fal-ai/patina', price: 0.01, maxSize: 2048 };
export type MaterialMap = 'basecolor' | 'normal' | 'roughness' | 'metalness' | 'height';

/**
 * Names for the shapes of a level that came without part names (core/naming.ts): a vision-language model through
 * fal's OpenRouter endpoint, charged by tokens (about half a cent per image asked about).
 */
export const VISION_MODEL = { key: 'gemini-flash', label: 'Gemini Flash', endpoint: 'openrouter/router/vision', model: 'google/gemini-3.8-flash', price: 0.005 };

/**
 * Geometry read back from a painted view, for the plane check (core/fidelity.ts): MoGe-2 predicts surface normals
 * from a single image. fal lists it per megapixel.
 */
export const GEOMETRY_MODEL = { key: 'moge-2', label: 'MoGe-2', endpoint: 'microsoft/moge-2', variant: 'vitl-normal', price: 0.01 };

/**
 * Texturing one part as a mesh of its own, for the part pass (core/partpass.ts): Meshy's retexture takes a mesh and
 * a description and returns the same mesh textured on every face. fal lists it per model, the same at 2K and 4K,
 * so 4K is asked for.
 */
export const PART_MODEL = { key: 'meshy-7', label: 'Meshy 7 retexture', endpoint: 'meshy/v7/retexture', price: 0.3 };
