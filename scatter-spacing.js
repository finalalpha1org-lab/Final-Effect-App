(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScatterSpacing = api;
})(globalThis, function () {
  const radius = (value) => Math.max(0, Number(value) || 0);
  function requiredDistance(radiusA, radiusB, sameSpacingClass, extraGap = 0) {
    const sum = radius(radiusA) + radius(radiusB);
    return sameSpacingClass ? sum + radius(extraGap) : sum * 0.9;
  }
  function overlaps(dx, dz, radiusA, radiusB, sameSpacingClass, extraGap = 0) {
    const minDistance = Math.max(0, requiredDistance(radiusA, radiusB, sameSpacingClass, extraGap) - 1e-6);
    return dx * dx + dz * dz < minDistance * minDistance;
  }
  return Object.freeze({ requiredDistance, overlaps });
});
