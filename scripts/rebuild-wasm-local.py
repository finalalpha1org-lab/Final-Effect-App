#!/usr/bin/env python3
"""Rebuild wasm/fe_core_engine.wasm with the zig compiler.

scripts/build-cpp-wasm.mjs is the project's own build script and needs Node,
which the analysis sandbox does not have. This helper reads the compiler flags
straight out of that script (single source of truth) and runs zig directly.

    uv pip install --quiet --target /tmp/zig_pkg ziglang     # if zig is missing
    python3 scripts/rebuild-wasm-local.py
"""
import io, hashlib, os, re, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
ZIG = os.environ.get('ZIG', '/tmp/zig_pkg/ziglang/zig')
if not os.path.exists(ZIG):
    ZIG = shutil.which('zig') or ZIG

src = io.open('scripts/build-cpp-wasm.mjs', encoding='utf-8').read()
start = src.find("execFileSync(zig.cmd, [...zig.args, 'c++',")
if start < 0:
    sys.exit('compile call not found in scripts/build-cpp-wasm.mjs')
i = src.index('(', start); depth = 0; j = i
while True:
    c = src[j]
    if c == '(': depth += 1
    elif c == ')':
        depth -= 1
        if depth == 0: break
    j += 1
tokens = re.findall(r"'([^']*)'|\.\.\.([A-Z_]+)", src[i + 1:j])
sources = re.findall(r"'([^']*)'", src[src.index('const CPP_SOURCES'):src.index('const REQUIRED_EXPORTS')])
argv = []
for lit, spread in tokens:
    if spread == 'CPP_SOURCES':
        argv += sources
    elif spread:
        sys.exit('unknown spread %s' % spread)
    else:
        argv.append(lit)
argv = argv[:argv.index('-o') + 2]        # drop the execFileSync options object
t0 = time.time()
r = subprocess.run([ZIG] + argv, capture_output=True, text=True)
if r.returncode != 0:
    sys.exit('zig failed (%s):\n%s\n%s' % (r.returncode, r.stdout[-2000:], r.stderr[-4000:]))
wasm = argv[-1]
size = os.path.getsize(wasm)
digest = hashlib.sha256(io.open(wasm, 'rb').read()).hexdigest()
shutil.copyfile(wasm, 'public/fe_core_engine.wasm')
if os.path.exists('fe_core_engine.wasm'):
    shutil.copyfile(wasm, 'fe_core_engine.wasm')
print('built %s in %.1fs: %d bytes sha256 %s' % (wasm, time.time() - t0, size, digest))
print('copied to public/ and the repository root')
