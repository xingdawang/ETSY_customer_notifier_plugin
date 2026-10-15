"""Build a dependency-free, unpackable extension ZIP; never include project data."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'manifest.json').read_text())['version']
output = root / 'dist' / f'etsy-message-sentinel-v{version}.zip'
files = ['manifest.json', 'core.js', 'adapters.js', 'storage.js', 'background.js', 'content.js',
         'dashboard.html', 'popup.html', 'ui.css', 'ui.js', 'README.md', 'PROTOCOL.md']
files += [str(path.relative_to(root)) for path in sorted((root / 'assets').glob('*')) if path.suffix in {'.png', '.svg'}]
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
print(output)
