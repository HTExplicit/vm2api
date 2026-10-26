"""Install script architecture helpers and ARM64 image-mode compose env."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / "deploy" / "install.sh"
DEFINITIONS, DISPATCH, _ = INSTALLER.read_text().partition('\nCOMMAND="install"\n')
if not DISPATCH:
    raise RuntimeError("Installer command dispatch marker not found")


def run_defs(body, extra_env=None):
    env = os.environ.copy()
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", "-c", DEFINITIONS + body],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )


class ArchMappingTests(unittest.TestCase):
    def test_arch_of_maps_common_uname_spellings(self):
        for machine, expected in (
            ("x86_64", "amd64"),
            ("amd64", "amd64"),
            ("aarch64", "arm64"),
            ("arm64", "arm64"),
            ("ARM64", "arm64"),
            ("i686", ""),
        ):
            with self.subTest(machine=machine):
                result = run_defs(f'arch_of "{machine}"')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_image_tag_for_arm64_pins_single_arch_release(self):
        result = run_defs('HOST_ARCH=arm64; image_tag_for "v1.4.04"')
        self.assertEqual(result.stdout.strip(), "v1.4.04-arm64")

    def test_image_mode_clears_source_arm64_compose_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            envf.write_text(
                "COMPOSE_FILE=docker-compose.yml:docker-compose.arm64.yml\n"
                "VM2API_IMAGE_TAG=v1.2.0-arm64\n",
                encoding="utf-8",
            )
            script = (
                DEFINITIONS
                + f'INSTALL_DIR="{tmp}"\n'
                + "HOST_ARCH=arm64\n"
                + "prepare_arch_env image\n"
                + 'grep "^COMPOSE_FILE=" "$INSTALL_DIR/.env"\n'
            )
            result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            compose_lines = [
                line for line in result.stdout.splitlines() if line.startswith("COMPOSE_FILE=")
            ]
            self.assertEqual(compose_lines, ["COMPOSE_FILE=docker-compose.yml"])


if __name__ == "__main__":
    unittest.main()
