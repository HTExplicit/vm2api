"""Check that replacing a Compose container preserves generated secrets."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[2] / "scripts" / "docker-entrypoint.sh"
SOURCE = ENTRYPOINT.read_text(encoding="utf-8")
START = SOURCE.index("env_get_file() {")
END = SOURCE.index('if [ "$STANDBY" = 0 ]; then\n  export VM2API_BOOTSTRAP', START)
BOOTSTRAP = SOURCE[START:END]


def start(root, standby=False, **overrides):
    env = dict(os.environ, ROOT=str(root), STANDBY="1" if standby else "0")
    for key in ("KIN_API_KEY", "KIN_DB_SECRET", "VM2API_API_KEY", "VM2API_DB_SECRET"):
        env.pop(key, None)
    env.update(overrides)
    probe = 'printf "%s\n" "$VM2API_API_KEY" "$VM2API_DB_SECRET"\n'
    result = subprocess.run(["sh", "-eu", "-c", BOOTSTRAP + probe], env=env,
                            check=True, capture_output=True, text=True, timeout=10)
    return result.stdout.splitlines()


class EntrypointSecretTests(unittest.TestCase):
    def test_replacing_the_container_reuses_secrets_from_its_data_mount(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "volume"
            data.mkdir()
            containers = [root / "old", root / "new"]
            for container in containers:
                container.mkdir()
                (container / "data").symlink_to(data)
                (container / ".env").write_text("VM2API_API_KEY=\nVM2API_DB_SECRET=\n")
            first = start(containers[0])
            self.assertEqual(len(first), 2)
            self.assertTrue(all(len(secret) == 64 for secret in first))
            self.assertEqual(start(containers[1], standby=True), first)
            self.assertEqual(start(containers[1]), first)
            self.assertEqual((data / ".bootstrap.env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                start(containers[1], VM2API_API_KEY="explicit-key", VM2API_DB_SECRET="explicit-secret"),
                ["explicit-key", "explicit-secret"],
            )
