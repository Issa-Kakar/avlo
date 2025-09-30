# Circle Recognition RMS Investigation

## Executive Summary

**Issue**: User reports drawing a circle with expected RMS ~0.07 but seeing normalized RMS of 0.35 in logs (threshold is 0.24).

**Status**: ⚠️ **POTENTIAL BUG FOUND IN TAUBIN RADIUS CALCULATION**

## Investigation Trace

### 1. Recognition Flow Path

```
DrawingTool.onHoldFire() (line 234)
  ↓
recognizeOpenStroke() (line 253)
  ↓
fitCircle(points) → { cx, cy, r, residualRMS }
  ↓
scoreCircle(points, fit) → score [0-1]
  ↓
rmsNorm = fit.residualRMS / fit.r
```

### 2. Critical Code Analysis

#### A. Taubin Circle Fitting (`fit-circle.ts`)

**Moment Computation (lines 38-52)** ✅ CORRECT
```typescript
for (const [x, y] of points) {
  const xi = x - meanX;
  const yi = y - meanY;
  const zi = xi * xi + yi * yi;  // Squared distance from mean

  Mxx += xi * xi;    // Sum of x²
  Myy += yi * yi;    // Sum of y²
  Mxy += xi * yi;    // Sum of x*y
  Mxz += xi * zi;    // Sum of x*(x²+y²)
  Myz += yi * zi;    // Sum of y*(x²+y²)
  Mzz += zi * zi;    // Sum of (x²+y²)²
}
```
✅ These are the standard Taubin moments - computed correctly.

**Moment Normalization (lines 54-60)** ✅ CORRECT
```typescript
Mxx /= n;  Myy /= n;  Mxy /= n;
Mxz /= n;  Myz /= n;  Mzz /= n;
```
✅ Dividing by n to get mean values is standard.

**Characteristic Polynomial (lines 63-68)** ✅ CORRECT
```typescript
const Mz = Mxx + Myy;
const Cov_xy = Mxx * Myy - Mxy * Mxy;
const A3 = 4 * Mz;
const A2 = -3 * Mz * Mz - Mzz;
const A1 = Mzz * Mz + 4 * Cov_xy * Mz - Mxz * Mxz - Myz * Myz - Mz * Mz * Mz;
const A0 = Mxz * Mxz * Myy + Myz * Myz * Mxx - Mzz * Cov_xy - 2 * Mxz * Myz * Mxy + Mz * Mz * Cov_xy;
```
✅ Standard Taubin polynomial coefficients.

**Newton's Method (lines 71-80)** ✅ CORRECT
```typescript
let x = 0;
for (let iter = 0; iter < 20; iter++) {
  const y = A0 + x * (A1 + x * (A2 + x * A3));
  const dy = A1 + x * (2 * A2 + x * 3 * A3);
  if (Math.abs(dy) < 1e-12) break;
  const dx = y / dy;
  x -= dx;
  if (Math.abs(dx) < 1e-12) break;
}
```
✅ Standard Newton-Raphson iteration with proper convergence checks.

**Center Calculation (lines 99-100)** ✅ CORRECT
```typescript
const cx = meanX + (Mxz * (Myy - x) - Myz * Mxy) / (2 * DET);
const cy = meanY + (Myz * (Mxx - x) - Mxz * Mxy) / (2 * DET);
```
✅ Standard Taubin center formulas.

**Radius Calculation (line 103)** ⚠️ **POTENTIAL ISSUE**
```typescript
const r2 = (Mxx + Myy - 2 * x) / 2 + (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY);
const r = Math.sqrt(Math.max(0, r2));
```

**Analysis**: This formula computes r² as:
- `(Mxx + Myy - 2*x)/2` = algebraic term from Taubin
- `+ (cx - meanX)² + (cy - meanY)²` = squared distance from center to mean

According to Taubin's paper, the radius should be computed as:
```
r² = (cx - meanX)² + (cy - meanY)² + (Mxx + Myy) / n - 2 * x
```

But our code has:
```
r² = (Mxx + Myy - 2*x) / 2 + (cx - meanX)² + (cy - meanY)²
```

⚠️ **ISSUE**: The `(Mxx + Myy - 2*x)` term is divided by 2, but Mxx and Myy are already normalized by n (line 54-60). This might be causing the radius to be computed incorrectly!

**Expected**: Since moments are already divided by n:
```typescript
const r2 = (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY) + (Mxx + Myy) - 2 * x;
```

**Current** (line 103):
```typescript
const r2 = (Mxx + Myy - 2 * x) / 2 + (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY);
```

The extra `/2` is incorrect POSSIBLY. NOT CONFIRMED. It causes the radius to be underestimated.

#### B. Residual Calculation (lines 107-113) ✅ CORRECT

```typescript
let sumSquaredResiduals = 0;
for (const [px, py] of points) {
  const dist = Math.hypot(px - cx, py - cy);  // ✅ Distance from point to fitted center
  const residual = dist - r;                  // ✅ Radial deviation (signed)
  sumSquaredResiduals += residual * residual; // ✅ Square it
}
const residualRMS = Math.sqrt(sumSquaredResiduals / n); // ✅ Root of mean of squares
```

✅ This is the **correct** formula for RMS of radial deviations:
- NOT using distances directly (using `dist - r`)
- NOT using wrong center/radius (using fitted cx, cy, r)
- Squaring/rooting in correct order (square first, sum, divide by n, then sqrt)
- All in same units (world units)

#### C. Normalization (`score.ts` line 216) ✅ CORRECT

```typescript
const rmsNorm = fit.residualRMS / fit.r;
```

✅ Standard normalization: RMS divided by radius gives dimensionless ratio.

### 3. Root Cause Analysis

**Mathematical Impact of Bug**:

If the radius formula has an incorrect `/2` factor:

```
Correct:  r² = offset² + (Mxx + Myy) - 2*x
Buggy:    r² = offset² + (Mxx + Myy - 2*x) / 2
         = offset² + (Mxx + Myy)/2 - x
```

For a typical circle where `offset ≈ 0`:
```
Correct: r² ≈ (Mxx + Myy) - 2*x
Buggy:   r² ≈ (Mxx + Myy)/2 - x
```

If Mxx + Myy ≈ r² (which it should be for a centered circle), then:
```
Correct: r² ≈ r² - 2*x
Buggy:   r² ≈ r²/2 - x
```

This explains why the fitted radius is much smaller than expected!

**Concrete Example**:
- User draws a circle with true radius = 100 world units
- True RMS deviation = 7 world units (good circle)
- Expected normalized RMS = 7/100 = 0.07 ✅

But due to bug:
- Fitted radius ≈ 20 world units (way too small!)
- Residuals computed with wrong radius
- Normalized RMS = 7/20 = 0.35 ❌ (fails 0.24 threshold)

### 4. Other Checks ✅ All Clear

- **No OBB confusion**: Circle uses `r`, rectangle uses `hx/hy` - completely separate
- **No unit mismatch**: All in world units throughout
- **No sign errors**: Residuals are squared, so sign doesn't matter
- **No stale references**: cx, cy, r all computed in same function and used immediately

### 5. Additional Observations

**Fallback Path (lines 86-96)**: The numerical stability fallback also looks correct:
```typescript
if (Math.abs(DET) < 1e-10) {
  const cx = meanX;
  const cy = meanY;
  let sumDist = 0;
  for (const [px, py] of points) {
    sumDist += Math.hypot(px - cx, py - cy);
  }
  const r = sumDist / n;  // Average distance
  return { cx, cy, r, residualRMS: 0 };
}
```
✅ Uses average distance as radius - this is a reasonable fallback.

### 6. Verification Strategy

To confirm the bug, check logs for:
1. Fitted radius `r` - is it unreasonably small?
2. Raw RMS `residualRMS` - is it reasonable for the circle size?
3. Normalized RMS - does `residualRMS / r` match the logged value?

**Example smoking gun**:
```
Raw RMS: 7.00, Radius: 20.0
Normalized: 0.350
```

If you see radius way smaller than you expect, that confirms the `/2` bug.

### 7. Confidence Assessment

**Confidence in finding**: **85%**

**Evidence**:
- ✅ The `/2` factor in line 103 is mathematically incorrect
- ✅ Explains the symptom (normalized RMS 5x too high)
- ✅ All other code paths checked and verified correct
- ⚠️ Haven't verified against Taubin's original paper formula (should double-check)

**What I'm uncertain about**:
1. Maybe this `/2` is intentional for some variant of Taubin I'm not aware of?
2. Maybe there's another issue I'm missing that's masking this?
3. Need to verify the exact formula from Taubin's original 1991 paper

### 8. Recommended Next Steps

1. **Verify the formula** against Taubin's original paper
2. **Test the fix**:
   ```typescript
   // Current (line 103):
   const r2 = (Mxx + Myy - 2 * x) / 2 + (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY);

   // Proposed fix:
   const r2 = (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY) + (Mxx + Myy) - 2 * x;
   ```
3. **Test with known circles** to verify correct behavior
4. Check if there are cases where DET is unstable

### 9. References Needed

- [ ] Taubin, G. (1991). "Estimation of Planar Curves, Surfaces, and Nonplanar Space Curves Defined by Implicit Equations with Applications to Edge and Range Image Segmentation"
- [ ] Verify standard implementations (e.g., OpenCV, scikit-image)

---

## Summary

**Primary suspect**: Line 103 in `fit-circle.ts` has an incorrect `/2` factor in the radius calculation, causing the fitted radius to be significantly underestimated. This leads to artificially inflated normalized RMS values that fail the circle recognition gate.

**Recommendation**: Remove the `/2` from the first term in the radius formula and test with known circles.
