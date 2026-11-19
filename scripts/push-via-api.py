"""github.com:443 不可达时，用 GitHub 的 Git Data API 把本地提交推到远端。

gh 走 api.github.com（可达），git push 走 github.com（不可达）。
按 git 对象模型逐个建 blob → tree → commit → 更新 ref。
"""
import base64
import json
import subprocess
import sys

REPO = 'sky-mirrors/tianshu-media-desk'
BRANCH = 'main'
WORKDIR = r'D:\text1\media-desk'


def gh(*args, input_text=None):
    result = subprocess.run(['gh', *args], cwd=WORKDIR, input=input_text,
                            capture_output=True, text=True, encoding='utf-8')
    if result.returncode != 0:
        raise SystemExit(f'gh {" ".join(args)} 失败:\n{result.stderr[:800]}')
    return result.stdout


def git(*args, binary=False):
    result = subprocess.run(['git', *args], cwd=WORKDIR, capture_output=True)
    if result.returncode != 0:
        raise SystemExit(f'git {" ".join(args)} 失败: {result.stderr[:400]}')
    return result.stdout if binary else result.stdout.decode('utf-8')


remote_head = json.loads(gh('api', f'repos/{REPO}/git/ref/heads/{BRANCH}'))['object']['sha']
base_tree = json.loads(gh('api', f'repos/{REPO}/git/commits/{remote_head}'))['tree']['sha']
local_head = git('rev-parse', 'HEAD').strip()
local_subject = git('log', '-1', '--pretty=%s').strip()
local_body = git('log', '-1', '--pretty=%b').strip()

print(f'远端 HEAD {remote_head[:8]} → tree {base_tree[:8]}')
print(f'本地 HEAD {local_head[:8]}  {local_subject}')

# 远端那个 commit 在本地可能不存在（它是 API 建的），diff 会失败。
# 这时用 --only 显式列出要推的文件，比如：python scripts/push-via-api.py --only PUBLISH.md
only = []
if '--only' in sys.argv:
    only = sys.argv[sys.argv.index('--only') + 1:]
if only:
    changed = only
else:
    changed = [line for line in git('diff', '--name-only', '-r', remote_head, 'HEAD').splitlines() if line.strip()]
if not changed:
    print('没有差异，结束')
    sys.exit(0)
print(f'改动文件 {len(changed)} 个: {changed}')

entries = []
for path in changed:
    blob = git('show', f'HEAD:{path}', binary=True)
    payload = json.dumps({'content': base64.b64encode(blob).decode('ascii'), 'encoding': 'base64'})
    sha = json.loads(gh('api', '--method', 'POST', f'repos/{REPO}/git/blobs', '--input', '-', input_text=payload))['sha']
    entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha})
    print(f'  blob {path} {sha[:8]}')

tree_payload = json.dumps({'base_tree': base_tree, 'tree': entries})
new_tree = json.loads(gh('api', '--method', 'POST', f'repos/{REPO}/git/trees', '--input', '-', input_text=tree_payload))['sha']

message = local_subject + ('\n\n' + local_body if local_body.strip() else '')
commit_payload = json.dumps({'message': message, 'tree': new_tree, 'parents': [remote_head]})
new_commit = json.loads(gh('api', '--method', 'POST', f'repos/{REPO}/git/commits', '--input', '-', input_text=commit_payload))['sha']

ref_payload = json.dumps({'sha': new_commit, 'force': False})
gh('api', '--method', 'PATCH', f'repos/{REPO}/git/refs/heads/{BRANCH}', '--input', '-', input_text=ref_payload)

print(f'已推送：远端 main → {new_commit[:12]}')
