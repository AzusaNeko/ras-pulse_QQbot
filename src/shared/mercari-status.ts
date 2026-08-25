/** Mercari uses `trading` while an item is already committed to a buyer. */
export function isSoldMercariStatus(status: string | undefined): boolean {
  return /SOLD|SOLD_OUT|TRADING/i.test(status ?? '')
}
