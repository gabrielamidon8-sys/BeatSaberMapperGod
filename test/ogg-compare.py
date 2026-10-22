# python3 ogg-compare.py original.f32 decoded.f32 channels  -> gain, delay, SNR, high-band retention
import sys, numpy as np
a = np.fromfile(sys.argv[1], dtype='<f4'); b = np.fromfile(sys.argv[2], dtype='<f4'); ch = int(sys.argv[3])
a = a.reshape(-1, ch); b = b.reshape(-1, ch); n = min(len(a), len(b)); a = a[:n]; b = b[:n]
x = a[:, 0].astype(np.float64); y = b[:, 0].astype(np.float64)
# best lag in +-64 samples
best = max(range(-64, 65), key=lambda L: np.dot(x[max(0, L):n + min(0, L)], y[max(0, -L):n - max(0, L)]))
xs = x[max(0, best):n + min(0, best)]; ys = y[max(0, -best):n - max(0, best)]
g = np.dot(xs, ys) / np.dot(xs, xs)
err = ys - g * xs
print('lag', best, 'gain', round(g, 4), 'SNR dB', round(10 * np.log10(np.dot(xs, xs) / np.dot(err, err)), 1))
def band(s, lo, hi):
    S = np.abs(np.fft.rfft(s[:len(s) // 4096 * 4096].reshape(-1, 4096) * np.hanning(4096), axis=1)); f = np.fft.rfftfreq(4096, 1 / 44100)
    return S[:, (f >= lo) & (f < hi)].sum()
for lo, hi in [(30, 200), (200, 2000), (2000, 8000), (8000, 14000), (14000, 18000)]:
    print(f'{lo}-{hi} Hz kept', round(band(ys, lo, hi) / band(xs, lo, hi), 3))
