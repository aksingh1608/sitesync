const EARTH_RADIUS_M = 6_371_008.8; // mean Earth radius (IUGG)

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A clock-in is flagged only when it is strictly farther than the radius. */
export const isOutsideGeofence = (distanceM: number, radiusM: number) => distanceM > radiusM;

/** Point `distanceM` metres due north of (lat, lng). Used by tests and seed. */
export function offsetNorth(lat: number, lng: number, distanceM: number): { lat: number; lng: number } {
  return { lat: lat + (distanceM / EARTH_RADIUS_M) * (180 / Math.PI), lng };
}
