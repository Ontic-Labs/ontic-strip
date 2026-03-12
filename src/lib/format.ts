import i18n from "../i18n";

export function formatDate(date: Date | string) {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(i18n.language).format(d);
}

export function formatNumber(num: number) {
  return new Intl.NumberFormat(i18n.language).format(num);
}

export function formatCurrency(num: number, currency = "USD") {
  return new Intl.NumberFormat(i18n.language, { style: "currency", currency }).format(num);
}
