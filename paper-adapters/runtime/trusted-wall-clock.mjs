const nativeDateNow = Date.now.bind(Date);

export function readTrustedWallClockEpochMs() {
  const value = Number(nativeDateNow());
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : Number.MAX_SAFE_INTEGER;
}
