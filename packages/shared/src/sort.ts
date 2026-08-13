export type CompareFn<T> = (a: T, b: T) => number;

export function defaultCompare<T>(a: T, b: T): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function partition<T>(arr: T[], lo: number, hi: number, compare: CompareFn<T>): number {
  const pivot = arr[hi];
  let i = lo - 1;
  for (let j = lo; j < hi; j++) {
    if (compare(arr[j], pivot) <= 0) {
      i++;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  [arr[i + 1], arr[hi]] = [arr[hi], arr[i + 1]];
  return i + 1;
}

function quickSortRange<T>(arr: T[], lo: number, hi: number, compare: CompareFn<T>): void {
  if (lo >= hi) return;
  const p = partition(arr, lo, hi, compare);
  quickSortRange(arr, lo, p - 1, compare);
  quickSortRange(arr, p + 1, hi, compare);
}

export function quickSort<T>(arr: T[], compare: CompareFn<T> = defaultCompare): T[] {
  const copy = [...arr];
  if (copy.length <= 1) return copy;
  quickSortRange(copy, 0, copy.length - 1, compare);
  return copy;
}

export function quickSortInPlace<T>(arr: T[], compare: CompareFn<T> = defaultCompare): T[] {
  if (arr.length <= 1) return arr;
  quickSortRange(arr, 0, arr.length - 1, compare);
  return arr;
}

function bubbleSortRange<T>(arr: T[], compare: CompareFn<T>): void {
  const n = arr.length;
  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      if (compare(arr[j], arr[j + 1]) > 0) {
        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
}

export function bubbleSort<T>(arr: T[], compare: CompareFn<T> = defaultCompare): T[] {
  const copy = [...arr];
  if (copy.length <= 1) return copy;
  bubbleSortRange(copy, compare);
  return copy;
}

export function bubbleSortInPlace<T>(arr: T[], compare: CompareFn<T> = defaultCompare): T[] {
  if (arr.length <= 1) return arr;
  bubbleSortRange(arr, compare);
  return arr;
}
