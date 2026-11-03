"""Converts DWG files to DXF so FloorPlanner can open them.

    python tools/convert.py "My flat.dwg" [more.dwg ...]

Writes "My flat.dxf" next to each file. Uses one of these free converters:
  - ODA File Converter (recommended on Windows):
    https://www.opendesign.com/guestfiles/oda_file_converter
  - LibreDWG's dwg2dxf, if it's on your PATH.
Set ODA_CONVERTER to the full path of ODAFileConverter.exe if it's installed somewhere unusual.
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_oda():
    if os.environ.get("ODA_CONVERTER"):
        return os.environ["ODA_CONVERTER"]
    patterns = [
        r"C:\Program Files\ODA\ODAFileConverter*\ODAFileConverter.exe",
        r"C:\Program Files (x86)\ODA\ODAFileConverter*\ODAFileConverter.exe",
        "/usr/bin/ODAFileConverter",
        "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter",
    ]
    for pattern in patterns:
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]  # newest version
    return shutil.which("ODAFileConverter")


def convert_with_oda(exe, dwg: Path, dxf: Path):
    # ODA converts whole folders, so work in temporary ones.
    with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
        shutil.copy(dwg, Path(src) / dwg.name)
        subprocess.run([exe, src, dst, "ACAD2018", "DXF", "0", "1", "*.DWG"], check=True)
        results = list(Path(dst).glob("*.dxf"))
        if not results:
            raise RuntimeError("ODA File Converter produced no DXF file. The DWG may be damaged.")
        shutil.move(str(results[0]), dxf)


def main(paths):
    if not paths:
        print(__doc__)
        return 1
    oda = find_oda()
    dwg2dxf = shutil.which("dwg2dxf")
    if not oda and not dwg2dxf:
        print("No DWG converter found. Install the free ODA File Converter:")
        print("  https://www.opendesign.com/guestfiles/oda_file_converter")
        print("then run this command again.")
        return 1

    failed = 0
    for p in paths:
        dwg = Path(p)
        dxf = dwg.with_suffix(".dxf")
        try:
            if oda:
                convert_with_oda(oda, dwg, dxf)
            else:
                subprocess.run([dwg2dxf, "-y", "-o", str(dxf), str(dwg)], check=True)
            print(f"OK   {dwg} -> {dxf}")
        except Exception as e:  # keep going with the other files
            print(f"FAIL {dwg}: {e}")
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
