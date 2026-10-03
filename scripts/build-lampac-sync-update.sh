#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
build_dir=${1:-/tmp/lampac-sync-delivery}
dotnet_bin=${DOTNET_BIN:-dotnet}
mkdir -p -- "$build_dir/publish" "$build_dir/update/Modules/Sync"
for module in Sync TimeCode Storage; do
    "$dotnet_bin" publish "$repo_dir/Modules/Sync/$module/$module.csproj" \
        --configuration Release --output "$build_dir/publish/$module" --verbosity minimal \
        -p:PlaywrightPlatform=linux -p:ErrorOnDuplicatePublishOutputFiles=false
done
python3 - "$repo_dir" "$build_dir" <<'PY'
from pathlib import Path
import shutil, sys, zipfile, hashlib
repo, build = map(Path, sys.argv[1:])
stage = build / 'update'
paths = [
    'Modules/Sync/Shared/SyncIdentity.cs', 'Modules/Sync/Shared/sync-account.js',
    'Modules/Sync/Sync/Controllers/SyncController.cs',
    'Modules/Sync/Sync/Controllers/BookmarkController.cs',
    'Modules/Sync/Sync/plugins/bookmark.js',
    'Modules/Sync/Sync/plugins/sync_v2/sync.js',
    'Modules/Sync/Sync/plugins/sync_v2/invc-ws.js',
    'Modules/Sync/Sync/manifest.json',
    'Modules/Sync/TimeCode/Controller.cs', 'Modules/Sync/TimeCode/plugin.js',
    'Modules/Sync/TimeCode/manifest.json',
    'Modules/Sync/Storage/Controller.cs', 'Modules/Sync/Storage/manifest.json'
]
for name in paths:
    target = stage / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(repo / name, target)
for module in ['Sync', 'TimeCode', 'Storage']:
    target = stage / 'Modules/Sync' / module
    shutil.copy2(build / 'publish' / module / (module + '.dll'), target)
    if module != 'Storage':
        common = build / 'publish' / module / 'sync-account.js'
        assert common.read_bytes() == (repo / 'Modules/Sync/Shared/sync-account.js').read_bytes()
        shutil.copy2(common, target)
shutil.copy2(repo / 'scripts/lampac-sync-INSTALL.txt', stage / 'INSTALL.txt')
archive = build / 'lampac-sync-update.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for file in sorted(stage.rglob('*')):
        if file.is_file(): bundle.write(file, file.relative_to(stage))
print('Update:', archive)
print('SHA256:', hashlib.sha256(archive.read_bytes()).hexdigest())
PY
