const EARTH_RADIUS_KM = 6371;

// Great-circle distance between two points, rounded to 2 decimals.
export function haversine_km(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const to_rad = (deg: number) => (deg * Math.PI) / 180;

  const d_lat = to_rad(lat2 - lat1);
  const d_lng = to_rad(lng2 - lng1);

  const a =
    Math.sin(d_lat / 2) ** 2 +
    Math.cos(to_rad(lat1)) * Math.cos(to_rad(lat2)) * Math.sin(d_lng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = EARTH_RADIUS_KM * c;

  return Math.round(distance * 100) / 100;
}

// distance_km / 30 km/h, in minutes, minimum 5.
export function eta_minutes(distance_km: number): number {
  return Math.max(5, Math.round((distance_km / 30) * 60));
}