// Analytic infinite dot-grid — full-screen triangle, AA dots, 2-band LOD crossfade.
// No vertex/index buffers, no textures: one 32-byte uniform, draw(3). Output is
// premultiplied (alphaMode 'premultiplied'), composited over the page background by
// the DOM. Tuning knobs arrive as pipeline-overridable constants mirroring grid-params.ts.

override BASE    : f32 = 5.0;    // bandRatio — geometric step between density bands
override MIN_PX  : f32 = 20.0;   // CSS px, finest visible spacing before promoting a band
override DOT_R   : f32 = 1.1;    // CSS px dot radius
override BASE_SP : f32 = 10.0;   // world units, finest band spacing

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
  let rPx = DOT_R * dpr;

  // Coarse dots are a positional subset of fine dots, so max() unions them: as the fine band
  // fades out (×(1-f)), the coarse dots occupy the exact same pixels — no popping, no moiré.
  let cov = max(dotCov(world, sCoarse, pxPerWorld, rPx),
                dotCov(world, sFine,   pxPerWorld, rPx) * (1.0 - f));

  let a = cov * u.col.a;
  return vec4f(u.col.rgb * a, a);                   // premultiplied
}
