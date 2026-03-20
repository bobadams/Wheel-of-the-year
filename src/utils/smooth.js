/** Circular Gaussian smooth — wraps at day 0/364 for seamless year-ring display. */
export function gaussianSmooth(arr, sigma = 7, kernelR = 14) {
  const gauss = x => Math.exp(-0.5 * (x / sigma) ** 2);
  return arr.map((_, i) => {
    let sum = 0, wt = 0;
    for (let k = -kernelR; k <= kernelR; k++) {
      const j = (i + k + arr.length) % arr.length;
      const w = gauss(k);
      sum += arr[j] * w;
      wt += w;
    }
    return Math.round((wt > 0 ? sum / wt : arr[i]) * 1000) / 1000;
  });
}
