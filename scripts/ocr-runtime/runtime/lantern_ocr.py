"""Relocatable Lantern entrypoint for the bundled OCRmyPDF runtime."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = Path(__file__).with_name("lantern_progress.py")
FIXTURE = ROOT / "share" / "fixtures" / "scan-fixture.pdf"
TESSDATA = ROOT / "share" / "tessdata"
sys.path.insert(0, str(ROOT / "lib"))
MODEL_SHA256 = {
    "eng": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "chi_sim": "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730",
}
PRODUCTION_FLAGS = (
    "--mode",
    "skip",
    "--output-type",
    "pdf",
    "--rasterizer",
    "pypdfium",
    "--optimize",
    "0",
    "--fast-web-view",
    "999999",
)


def _configure_environment() -> None:
    binary_dir = ROOT / "bin"
    current_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join((str(binary_dir), current_path))
    os.environ["TESSDATA_PREFIX"] = str(TESSDATA)
    os.environ.setdefault("OMP_THREAD_LIMIT", "1")


def _run_ocrmypdf(arguments: list[str]) -> int:
    from ocrmypdf.__main__ import run

    exit_code = int(run(["--plugin", str(PLUGIN), *arguments]))
    if exit_code == 0:
        # OCRmyPDF loads file plugins after argument parsing and replaces the
        # module in sys.modules. Import after run() so completion reads the
        # same statistics instance that the plugin hooks updated.
        from lantern_progress import _write_json, complete_payload

        _write_json(complete_payload())
    return exit_code


def _normal_ocr(arguments: list[str]) -> int:
    if len(arguments) < 2:
        print("expected INPUT_PDF OUTPUT_PDF", file=sys.stderr)
        return 2
    return _run_ocrmypdf(arguments)


def _self_test() -> int:
    for language, expected_sha256 in MODEL_SHA256.items():
        model = TESSDATA / f"{language}.traineddata"
        if not model.is_file():
            raise RuntimeError(f"missing language model: {language}")
        digest = hashlib.sha256()
        with model.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError(f"language model failed integrity check: {language}")
    if not FIXTURE.is_file():
        raise RuntimeError("missing OCR fixture")

    executable = ROOT / "bin" / ("lantern-ocr.exe" if os.name == "nt" else "lantern-ocr")
    version = subprocess.run(
        [str(executable), "--version"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout.strip()

    with tempfile.TemporaryDirectory(prefix="lantern-ocr-self-test-") as temporary:
        output = Path(temporary) / "output.pdf"
        smoke = subprocess.run(
            [
                str(executable),
                *PRODUCTION_FLAGS,
                "--jobs",
                "1",
                "-l",
                "chi_sim+eng",
                "--",
                str(FIXTURE),
                str(output),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if smoke.returncode != 0:
            raise RuntimeError(f"fixture OCR failed: {smoke.stderr[-2000:]}")
        try:
            events = [json.loads(line) for line in smoke.stdout.splitlines()]
        except json.JSONDecodeError as error:
            raise RuntimeError("fixture OCR emitted non-JSON stdout") from error
        complete = events[-1] if events else {}
        if (
            complete.get("type") != "complete"
            or complete.get("pages") != 1
            or complete.get("ocr_pages") != 1
            or not any(event.get("type") == "progress" for event in events)
        ):
            raise RuntimeError("fixture OCR did not emit a complete JSONL event")

        import pypdfium2

        pdf = pypdfium2.PdfDocument(output)
        try:
            if len(pdf) != 1:
                raise RuntimeError("fixture output page count changed")
            text = pdf[0].get_textpage().get_text_range()
            if "Lantern" not in text:
                raise RuntimeError("fixture OCR output lacks expected text")
        finally:
            pdf.close()

    result = {
        "ok": True,
        "ocrmypdf_version": version,
        "languages": ["chi_sim", "eng"],
        "fixture": FIXTURE.name,
    }
    print(json.dumps(result, separators=(",", ":")))
    return 0


def main() -> int:
    _configure_environment()
    arguments = sys.argv[1:]
    if arguments == ["--self-test"]:
        return _self_test()
    if arguments == ["--version"]:
        from ocrmypdf import __version__

        print(f"lantern-ocr {__version__}")
        return 0
    return _normal_ocr(arguments)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"lantern-ocr: {error}", file=sys.stderr)
        raise SystemExit(1) from error
