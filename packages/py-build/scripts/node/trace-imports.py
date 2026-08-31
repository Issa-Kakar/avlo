"""Observe-only import recorder — run inside the fork interpreter by
trace-imports.mjs (its source is runPython'd verbatim at boot).

A finder at sys.meta_path position 0 records every import ATTEMPT
(find_spec call) and resolves nothing (returns None), so the machinery
behaves exactly as without it. The dump reports both:

- attempted: every name the import system was asked for — the strict set for
  the PIL/fontTools ban (a residual pillow site is a violation even if the
  import would fail at runtime);
- loaded: sys.modules at dump time — the needed-set for trace ∩ prune = ∅
  (try/except probes of genuinely-absent optionals don't count against a
  prune list; only modules that actually loaded do).
"""

import json
import sys


class _AvloTraceFinder:
    def __init__(self):
        self.attempted = set()

    def find_spec(self, fullname, path=None, target=None):
        self.attempted.add(fullname)
        return None


_avlo_tracer = _AvloTraceFinder()
sys.meta_path.insert(0, _avlo_tracer)


def _avlo_trace_dump():
    return json.dumps(
        {
            "attempted": sorted(_avlo_tracer.attempted),
            "loaded": sorted(m for m in sys.modules if sys.modules[m] is not None),
        }
    )
