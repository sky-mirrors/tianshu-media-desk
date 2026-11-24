"""给 dist/ 补官方的两个根元数据，再打成 ZIP。

格式来自官方 devkit 的 sample-out.zip：
  xiaosi.release.json  —— 发布声明（pack 命令的参数落在这里）
  xiaosi.contents.json —— 逐文件 sha256 清单，schema xiaosi.contents/1，不含它自己
"""
import hashlib
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(ROOT, 'tianshu-media-desk-0.1.1.zip')
SEP = '\\'

PUBLISHER_ID = 'b226234e-c3c8-4223-9e58-7e9fadbb5bea'
RELEASE_ID = 'rel_media_desk_011'


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def walk_files():
    for root, _dirs, files in os.walk(DIST):
        for name in sorted(files):
            full = os.path.join(root, name)
            yield full, os.path.relpath(full, DIST).replace(SEP, '/')


manifest = json.load(open(os.path.join(DIST, 'tianshu.plugin.json'), encoding='utf-8'))
source_commit = sys.argv[1] if len(sys.argv) > 1 else ''

# 1) 发布声明：字段顺序按官方 sample-out.zip
release = {
    'channel': 'stable',
    'compatibility': {
        'core': (manifest.get('engines') or {}).get('tianshu', '>=4.0.2 <5.0.0'),
        'platforms': ['win32-x64'],
        'tpi': manifest.get('$tpi', '1.0'),
    },
    'data_schema': 1,
    'migration_kind': 'none',
    'permission_digest': hashlib.sha256(json.dumps(manifest.get('permissions', {}), separators=(',', ':')).encode()).hexdigest(),
    'plugin_id': manifest['id'],
    'publisher_id': PUBLISHER_ID,
    'release_id': RELEASE_ID,
    'runtime': manifest.get('runtime', 'agent'),
    'schema': 'xiaosi.release/1',
    'source_commit': source_commit,
    'version': manifest['version'],
}
with open(os.path.join(DIST, 'xiaosi.release.json'), 'w', encoding='utf-8') as handle:
    json.dump(release, handle, separators=(',', ':'))

# 2) 内容清单：除自己以外的每个文件
contents = {
    'files': {arc: sha256_of(full) for full, arc in walk_files() if arc != 'xiaosi.contents.json'},
    'schema': 'xiaosi.contents/1',
}
with open(os.path.join(DIST, 'xiaosi.contents.json'), 'w', encoding='utf-8') as handle:
    json.dump(contents, handle, separators=(',', ':'))

# 3) 打 ZIP（条目用 / 分隔）
# 时间戳固定成 1980-01-01：否则同一份内容每次打包的 artifact_sha256 都不同，
# PUBLISH.md 记的校验值就没法作为「这个包就是它」的凭据。
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as archive:
    for full, arc in walk_files():
        info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, open(full, 'rb').read())

print(f'zip: {OUT}')
print(f'  {os.path.getsize(OUT)} bytes | {len(zipfile.ZipFile(OUT).namelist())} entries')
print(f'  permission_digest: {release["permission_digest"]}')
print(f'  contents files: {len(contents["files"])}')
