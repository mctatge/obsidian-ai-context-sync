"""Prepare only reviewed runtime files; never include a vault or plugin data.json."""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile
root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
package = json.loads((root / "package.json").read_text())
if manifest["version"] != package["version"]:
    raise SystemExit("Package and manifest versions differ")
output = root / "dist" / "ai-context-sync"
output.mkdir(parents=True, exist_ok=True)
names = ["main.js", "manifest.json", "styles.css"]
for name in names:
    shutil.copyfile(root / name, output / name)
archive = root / "dist" / f'ai-context-sync-{manifest["version"]}.zip'
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    for name in names:
        bundle.write(output / name, f"ai-context-sync/{name}")
checksums = []
for item in [*(output / name for name in names), archive]:
    checksums.append(f"{hashlib.sha256(item.read_bytes()).hexdigest()}  {item.relative_to(root / 'dist')}")
(root / "dist" / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
print(f"Prepared {archive.relative_to(root)} and three Obsidian runtime assets")
