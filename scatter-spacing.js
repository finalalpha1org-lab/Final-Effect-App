(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScatterSpacing = api;
})(globalThis, function () {
  const radius = (value) => Math.max(0, Number(value) || 0);
  /* A tree needs room for its crown; undergrowth only needs room for its trunk.
     That difference is the whole point of the two radii below. */
  const CROWN_SHARE = 0.55;
  const UNDER_SHARE = 0.9;
  function requiredDistance(radiusA, radiusB, sameSpacingClass, extraGap = 0) {
    const sum = radius(radiusA) + radius(radiusB);
    return sameSpacingClass ? sum + radius(extraGap) : sum * 0.9;
  }
  function overlaps(dx, dz, radiusA, radiusB, sameSpacingClass, extraGap = 0) {
    const minDistance = Math.max(0, requiredDistance(radiusA, radiusB, sameSpacingClass, extraGap) - 1e-6);
    return dx * dx + dz * dz < minDistance * minDistance;
  }
  /* Placement distance between two plants, each described by the radius of what
     it occupies at eye height (its crown) and the radius of what physically
     blocks the ground (its trunk or base).
   *
   * The old rule added the two footprints together for every pair, which meant
   * an oak kept a 16 m circle clear of *everything*: no sapling, no shrub, no
   * rock, no boulder under its crown. A wood placed that way is a field of
   * isolated trunks with bare ground between them - exactly the "few trees,
   * scattered clumps" the studio was showing.
   *
   * Two trees still have to compete for canopy space, but only for the crown
   * they cannot share: CROWN_SHARE of the two radii. Anything that lives on the
   * forest floor - shrub, fern, boulder, flower - only has to clear the trunk,
   * because that is all it can collide with. */
  function plantDistance(crownA, trunkA, crownB, trunkB, treePair, extraGap = 0) {
    const gap = radius(extraGap);
    if (treePair) return Math.max(0, CROWN_SHARE * (radius(crownA) + radius(crownB)) + gap);
    const clearance = radius(trunkA) + radius(trunkB) + gap;
    const floor = UNDER_SHARE * Math.min(radius(crownA), radius(crownB));
    return Math.max(clearance, floor);
  }
  function plantClash(dx, dz, crownA, trunkA, crownB, trunkB, treePair, extraGap = 0) {
    const minDistance = Math.max(0, plantDistance(crownA, trunkA, crownB, trunkB, treePair, extraGap) - 1e-6);
    return dx * dx + dz * dz < minDistance * minDistance;
  }
  return Object.freeze({ requiredDistance, overlaps, plantDistance, plantClash, CROWN_SHARE, UNDER_SHARE });
});
