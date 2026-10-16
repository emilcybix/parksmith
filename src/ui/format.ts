/** Money as the HUD shows it: whole dollars with thousands separators; `signed` adds + or − (a true minus sign). */
export const formatMoney = (value: number, signed = false): string => {
  const rounded = Math.round(Math.abs(value)).toLocaleString();
  if (!signed || value === 0) return `${value < 0 ? '−' : ''}$${rounded}`;
  return `${value > 0 ? '+' : '−'}$${rounded}`;
};
