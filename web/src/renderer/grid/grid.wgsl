// Analytic infinite dot-grid — full-screen triangle, AA dots, 2-band LOD crossfade.
// No vertex/index buffers, no textures: one 32-byte uniform, draw(3). Output is
// premultiplied (alphaMode 'premultiplied'), composited over the page background by
// the DOM. Tuning knobs arrive as pipeline-overridable constants mirroring grid-params.ts.

override BASE      : f32 = 5.0;    // bandRatio — geometric step between density bands
override MIN_PX    : f32 = 20.0;   // CSS px, finest visible spacing before promoting a band
override DOT_R     : f32 = 1.1;    // CSS px floor dot radius (held through the cross-fade region)
override DOT_R_MAX : f32 = 2.6;    // CSS px cap on the zoom-scaled dot radius past the solo point
override BASE_SP   : f32 = 12.0;   // world units, finest band spacing

// cam = (panX, panY, scale = cssPxPerWorld, dpr);  col = (r, g, b, alphaMax)
struct Grid { cam : vec4f, col : vec4f };
@group(0) @binding(0) var<uniform> u : Grid;

@vertex fn vs(@builtin(vertex_index) vid : u32) -> @builtin(position) vec4f {
  // Oversized triangle covering the whole clip volume (no vertex buffer).
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vid], 0.0, 1.0);
}

// Coverage of the dot lattice at `spacing` for a world point, AA'd over ~1 device px.
fn dotCov(world : vec2f, spacing : f32, pxPerWorld : f32, rPx : f32) -> f32 {
  let g = world / spacing;
  let d = length((g - round(g)) * spacing) * pxPerWorld; // device-px dist to nearest lattice point
  return 1.0 - smoothstep(rPx - 0.5, rPx + 0.5, d);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let pan = u.cam.xy;
  let scale = u.cam.z;
  let dpr = u.cam.w;
  let pxPerWorld = scale * dpr;
  let world = pan + frag.xy / pxPerWorld;          // device-px frag → world (y-down, no flip)

  let lvl = max(0.0, log2(MIN_PX / (BASE_SP * scale)) / log2(BASE));
  let l0 = floor(lvl);
  let f = lvl - l0;                                 // cross-band fade fraction
  let sFine = BASE_SP * pow(BASE, l0);
  let sCoarse = sFine * BASE;

  // Radius grows with the finest band's on-screen (CSS) spacing, clamped to [DOT_R, DOT_R_MAX].
  // slope DOT_R/MIN_PX ⇒ pinned at DOT_R for every spacing ≤ MIN_PX (the whole cross-fade region,
  // so no radius pop across band promotions) then fattening once the lone band spreads past solo.
  let rCss = clamp(sFine * scale * (DOT_R / MIN_PX), DOT_R, DOT_R_MAX);
  let rPx = rCss * dpr;

  // Smoothstep-eased fade so a band eases in/out rather than ramping linearly (softens the ends,
  // where popping is felt). The dying fine dots also shrink toward the coarse dots — receding, not
  // just dimming. Coarse dots (the survivors) keep rPx, so the union is pop-free: coarse dots are a
  // positional subset of fine dots and occupy the exact same pixels as the fine band fades out.
  let fade = smoothstep(0.0, 1.0, f);
  let rFine = rPx * (1.0 - 0.5 * f);
  let cov = max(dotCov(world, sCoarse, pxPerWorld, rPx),
                dotCov(world, sFine,   pxPerWorld, rFine) * (1.0 - fade));

  let a = cov * u.col.a;
  return vec4f(u.col.rgb * a, a);                   // premultiplied
}
