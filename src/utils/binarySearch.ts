const binarySearch = <T>(arr: T[], f: (item: T) => boolean): number => {
  let left = -1;
  let right = arr.length;

  while (right - left > 1) {
    const mid = Math.floor((left + right) / 2);
    if (f(arr[mid])) {
      right = mid;
    } else {
      left = mid;
    }
  }

  return right;
};

export default binarySearch;
