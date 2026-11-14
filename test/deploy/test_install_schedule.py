"""Run with: python3 -m unittest discover -s test/deploy -v."""

import ast
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / "deploy" / "install.sh"
# Load definitions without running the installer's command dispatch.
DEFINITIONS, DISPATCH, _ = INSTALLER.read_text(encoding="utf-8").partition('\nCOMMAND="install"\n')
if not DISPATCH:
    raise RuntimeError("Installer command dispatch marker not found")


def run_installer(command, response=None, extra_env=None, mock=None):
    env = os.environ.copy()
    env["MOCK_RESPONSE"] = json.dumps(response)
    env.update(extra_env or {})
    script = DEFINITIONS + '\ncurl() { printf "%s" "$MOCK_RESPONSE"; }\n'
    if mock:
        script += mock + "\n"
    return subprocess.run(
        ["bash"], input=script + command + "\n",
        env=env, capture_output=True, text=True, encoding="utf-8", timeout=10,
    )


class ScheduleTests(unittest.TestCase):
    def test_install_and_upgrade_run_shared_fleet_once_and_honor_skip_options(self):
        mock = r'''
need_root() { :; }
require_cmds() { :; }
resolve_host_arch() { HOST_ARCH=amd64; }
print_banner() { :; }
local_version() { echo 1.4.6901; }
latest_release_tag() { echo v1.4.6901; }
install_mode() { echo image; }
fetch_release_files() { :; }
ensure_env() { :; }
env_set() { :; }
prepare_arch_env() { :; }
prepare_arm64_host() { :; }
print_changelog_slice() { :; }
release_notes() { :; }
print_login_banner() { :; }
wait_health() { :; }
compose() { :; }
sync_wrap_cli() { echo unexpected-second-sync >> "$TRACE"; }
docker() {
  case "$*" in
    *'test -f'*) return 0 ;;
    *) printf '%s\n' "$*" >> "$TRACE"; return "$FLEET_EXIT" ;;
  esac
}
'''
        for command in ("cmd_install", "cmd_upgrade"):
            for enabled in (False, True):
                for no_start in (False, True):
                    for failed in (False, True):
                        with self.subTest(command=command, sync=enabled, no_start=no_start, failed=failed), tempfile.TemporaryDirectory() as tmp:
                            trace = Path(tmp) / "trace"
                            (Path(tmp) / "docker-compose.yml").write_text("")
                            result = run_installer(
                                'INSTALL_DIR="$TEST_ROOT"; SYNC_WRAP="$TEST_SYNC"; NO_START="$TEST_NO_START"; CRAG_TARGET_VERSION=v2.0.2; ' + command,
                                mock=mock, extra_env={
                                    "TRACE": str(trace), "TEST_ROOT": tmp,
                                    "TEST_SYNC": str(int(enabled)), "TEST_NO_START": str(int(no_start)),
                                    "FLEET_EXIT": "22" if failed else "0",
                                },
                            )
                            should_refresh = enabled and not no_start
                            self.assertEqual(result.returncode, int(should_refresh and failed), result.stderr)
                            lines = trace.read_text().splitlines() if trace.exists() else []
                            self.assertEqual(lines, [
                                "exec vm2api node /opt/vm2api/scripts/fleet-services.mjs /opt/vm2api 4 v2.0.2"
                            ] if should_refresh else [])
                            if should_refresh and failed:
                                self.assertNotIn("安装完成", result.stdout)
                                self.assertNotIn("已更新到", result.stdout)

    def test_crag_update_uses_existing_host_or_container_without_compose_restart(self):
        for container in (False, True):
            with self.subTest(container=container), tempfile.TemporaryDirectory() as tmp:
                trace = Path(tmp) / "trace"
                mock = r'''
need_root() { :; }
docker() {
  if [ "$1" = inspect ]; then echo "$CONTAINER"; return; fi
  printf 'docker:%s\n' "$*" >> "$TRACE"
}
node() { printf 'node:%s\n' "$*" >> "$TRACE"; }
'''
                result = run_installer(
                    'INSTALL_DIR=/test-root; CRAG_TARGET_VERSION=v2.0.1; cmd_update_crag',
                    mock=mock, extra_env={"TRACE": str(trace), "CONTAINER": str(container).lower()},
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = (
                    'docker:exec vm2api node /opt/vm2api/scripts/update-crag.mjs /opt/vm2api v2.0.1'
                    if container else 'node:/test-root/scripts/update-crag.mjs /test-root v2.0.1'
                )
                self.assertEqual(trace.read_text().strip(), expected)

    def test_crag_update_rejects_no_start_before_any_mutation(self):
        result = run_installer(
            'NO_START=1; cmd_update_crag',
            mock='need_root() { :; }; node() { exit 99; }; docker() { exit 99; }',
        )
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_inline_python_supports_python_38_grammar(self):
        snippets = re.findall(r"python3 -c '([^']*)'", DEFINITIONS)
        self.assertTrue(snippets)
        for i, code in enumerate(snippets, 1):
            with self.subTest(snippet=i):
                ast.parse(code, feature_version=(3, 8))

    def test_sync_restarts_changed_slots_without_pausing(self):
        mock = r'''
read_env_key() {
  case "$1" in
    VM2API_API_KEY) echo test-key ;;
    PORT) echo 16801 ;;
  esac
}
curl() {
  local args="$*" step
  case "$args" in
    *'"restart":false'*)
      step=check
      printf '%s' '{"ok":true,"data":{"total":2,"changed_count":2,"failed_count":0}}'
      ;;
    *'"restart":true'*)
      step=sync
      if [ "$FAIL_SYNC" = 1 ]; then
        echo "$step" >> "$TRACE"
        return 22
      fi
      printf '%s' '{"ok":true,"data":{"total":2,"ok_count":2,"failed_count":0}}'
      ;;
    *) return 22 ;;
  esac
  echo "$step" >> "$TRACE"
}
'''
        for fail in (False, True):
            with self.subTest(fail_sync=fail), tempfile.TemporaryDirectory() as tmp:
                trace = Path(tmp) / "trace"
                result = run_installer(
                    "sync_wrap_cli", mock=mock,
                    extra_env={"TRACE": str(trace), "FAIL_SYNC": str(int(fail))},
                )
                self.assertEqual(result.returncode, int(fail), result.stderr)
                self.assertEqual(trace.read_text().splitlines(), ["check", "sync"])
                if not fail:
                    self.assertIn("wrap-cli/sync: 2/2, failed=0", result.stdout)


if __name__ == "__main__":
    unittest.main()
