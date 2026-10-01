/*
 * Pure rules of the fiado (spec 06): identification data of a customer (RN-06.01, RN-06.02).
 */

/** RN-06.03: the name a customer gets when removed at their request (LGPD). */
export const REMOVED_CUSTOMER_NAME = 'Cliente removido';

/** Only the digits of a phone or a CPF typed with punctuation. */
export function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * RN-06.01: Brazilian phone with area code (DDD), digits only: 10 digits (landline) or 11 (mobile,
 * starting with 9 after the DDD). The DDD has no zero.
 */
export function isValidPhone(digits: string): boolean {
  if (!/^[1-9][1-9]\d{8,9}$/.test(digits)) {
    return false;
  }
  return digits.length === 10 || digits[2] === '9';
}

/** RN-06.01: CPF with valid check digits (and not all digits equal). */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) {
    return false;
  }
  const numbers = Array.from({ length: 11 }, (_, index) => Number(digits.charAt(index)));
  const checkDigit = (length: number): number => {
    let sum = 0;
    for (let index = 0; index < length; index++) {
      sum += (numbers[index] ?? 0) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return checkDigit(9) === numbers[9] && checkDigit(10) === numbers[10];
}
