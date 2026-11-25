"""把 dist/ 打成提交用的 ZIP。

为什么不用 .NET 的 CreateFromDirectory：Windows 上它会写出 `\` 作分隔符的条目，
`unzip` 会告警、部分平台解不开。zipfile 写的是规范要求的 `/`。

用法：python scripts/make-zip.py [输出路径]
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'dist')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tianshu-media-desk-0.1.2.zip')
SEP = '\\'

if not os.path.isdir(SRC):
    raise SystemExit(f'dist/ 不存在：先跑 node scripts/pack-release.mjs（{SRC}）')

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as archive:
    for root, _dirs, files in os.walk(SRC):
        for name in sorted(files):
            full = os.path.join(root, name)
            arc = os.path.relpath(full, SRC).replace(SEP, '/')
            archive.write(full, arc)

size = os.path.getsize(OUT)
check = zipfile.ZipFile(OUT)
names = check.namelist()
bad = sum(1 for n in names if SEP in n)
print(f'written {OUT}')
print(f'  {size} bytes | {len(names)} entries | backslash entries: {bad}')
print(f'  sample: {names[:6]}')
if bad:
    raise SystemExit('存在反斜杠条目，zip 不合规')
