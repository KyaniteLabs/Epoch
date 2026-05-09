export function defined<T>(value: T, message = "Expected value to be defined"): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value as NonNullable<T>;
}
