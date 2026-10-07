// gold-api（現物スポット）から XAU/USD のスポット価格を取得する。
// /mtf は金先物(GC=F)基準のため、ゴールドの現在レート・価格をスポット基準に揃える用途で使う。
// 取得失敗・不正値は null（呼び出し側は GC=F のままにフォールバック）。
export async function fetchGoldSpot(): Promise<number | null> {
  try {
    const res = await fetch('https://api.gold-api.com/price/XAU');
    const spot = parseFloat((await res.json())?.price);
    return Number.isFinite(spot) && spot > 0 ? spot : null;
  } catch {
    return null;
  }
}
