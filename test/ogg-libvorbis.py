# Decode an .ogg with the reference libvorbis (via ctypes) and report channels, rate, samples; optionally dump f32.
import ctypes, sys, numpy as np
lib = ctypes.CDLL('libvorbisfile.so.3')
class Info(ctypes.Structure):
    _fields_ = [('version', ctypes.c_int), ('channels', ctypes.c_int), ('rate', ctypes.c_long), ('bitrate_upper', ctypes.c_long), ('bitrate_nominal', ctypes.c_long), ('bitrate_lower', ctypes.c_long), ('bitrate_window', ctypes.c_long), ('codec_setup', ctypes.c_void_p)]
lib.ov_info.restype = ctypes.POINTER(Info)
lib.ov_pcm_total.restype = ctypes.c_int64
vf = ctypes.create_string_buffer(4096)
rc = lib.ov_fopen(sys.argv[1].encode(), vf)
if rc != 0: print('ov_fopen failed', rc); sys.exit(1)
info = lib.ov_info(vf, -1).contents
total = lib.ov_pcm_total(vf, -1)
print('libvorbis ok: channels', info.channels, 'rate', info.rate, 'samples', total)
pcm = ctypes.POINTER(ctypes.POINTER(ctypes.c_float))()
bit = ctypes.c_int(0)
out = [[] for _ in range(info.channels)]
got = 0
while True:
    n = lib.ov_read_float(vf, ctypes.byref(pcm), 4096, ctypes.byref(bit))
    if n <= 0:
        if n < 0: print('decode error', n); sys.exit(2)
        break
    for c in range(info.channels): out[c].append(np.ctypeslib.as_array(pcm[c], shape=(n,)).copy())
    got += n
print('decoded', got)
if len(sys.argv) > 2:
    a = np.stack([np.concatenate(c) for c in out], axis=1).astype('<f4'); a.tofile(sys.argv[2])
