import type { GoogleAdsStatus } from "@mohassan/contracts";

/** A saved draft never borrows currency or time zone from a different selected account. */
export function accountForDraft(customerId: string, status: GoogleAdsStatus) {
  return status.account?.customerId === customerId ? status.account : null;
}

/** Currency comes from the observed account/report; missing currency stays explicitly unconfirmed. */
export function moneyOf(micros: string, currency: string): string {
  const value = Number(micros) / 1_000_000;
  if (currency === "GBP") return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
  if (!/^[A-Z]{3}$/.test(currency)) return `${new Intl.NumberFormat("ar", { maximumFractionDigits: 2 }).format(value)} (عملة الحساب غير مؤكدة)`;
  return new Intl.NumberFormat("ar", { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: 2 }).format(value);
}
