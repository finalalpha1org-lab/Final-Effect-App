(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CelestialMath = api;
})(globalThis, function () {
  const DEG = Math.PI / 180;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function cartesianFromSpherical(body) {
    const distance = Math.max(Number(body.dist) || 100, 5);
    const elevation = (Number(body.el) || 0) * DEG;
    const azimuth = (Number(body.az) || 0) * DEG;
    return [
      distance * Math.cos(elevation) * Math.cos(azimuth),
      distance * Math.sin(elevation),
      distance * Math.cos(elevation) * Math.sin(azimuth),
    ];
  }

  function setFromCartesian(body, x, y, z) {
    const apparentSize = body.size;
    const distance = Math.max(Math.hypot(x, y, z), 5);
    body.dist = distance;
    body.el = Math.asin(clamp(y / distance, -1, 1)) / DEG;
    body.az = (Math.atan2(z, x) / DEG + 360) % 360;
    body.size = apparentSize;
    return body;
  }

  function angularRadius(body) {
    return Math.max(0, Number(body.size) || 0) * DEG;
  }

  function moonOrbitDirection(timeAngle, globalAzimuthDegrees, azimuthOffsetDegrees, orbitPositionDegrees) {
    const time = Number.isFinite(Number(timeAngle)) ? Number(timeAngle) : 0;
    const globalAzimuth = Number.isFinite(Number(globalAzimuthDegrees)) ? Number(globalAzimuthDegrees) : 0;
    const azimuthOffset = Number.isFinite(Number(azimuthOffsetDegrees)) ? Number(azimuthOffsetDegrees) : 0;
    const orbitPosition = Number.isFinite(Number(orbitPositionDegrees)) ? Number(orbitPositionDegrees) : 0;
    const azimuth = (globalAzimuth + azimuthOffset) * DEG;
    const angle = time + orbitPosition * DEG;
    return [Math.cos(angle) * Math.cos(azimuth), Math.sin(angle), Math.cos(angle) * Math.sin(azimuth)];
  }

  function moonPhaseLighting(direction, phaseDegrees) {
    const length = Math.hypot(...direction) || 1;
    const moon = direction.map(value => Number(value) / length);
    const up = Math.abs(moon[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const perpendicular = [
      moon[1] * up[2] - moon[2] * up[1],
      moon[2] * up[0] - moon[0] * up[2],
      moon[0] * up[1] - moon[1] * up[0],
    ];
    const perpendicularLength = Math.hypot(...perpendicular) || 1;
    const phase = clamp(Number.isFinite(Number(phaseDegrees)) ? Number(phaseDegrees) : 180, 0, 360) * DEG;
    const cosine = Math.cos(phase), sine = Math.sin(phase);
    return {
      direction: moon.map((value, index) => value * cosine + perpendicular[index] / perpendicularLength * sine),
      illuminatedFraction: clamp((1 - cosine) / 2, 0, 1),
    };
  }

  return Object.freeze({ cartesianFromSpherical, setFromCartesian, angularRadius, moonOrbitDirection, moonPhaseLighting });
});
