export function formatParentBirthday(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export function isValidParentBirthday(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return false;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const shortYear = Number(match[3]);
  const fullYear = shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear;
  const date = new Date(fullYear, month - 1, day);

  return (
    date.getFullYear() === fullYear &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}
