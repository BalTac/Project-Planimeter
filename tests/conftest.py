"""Pytest fixtures for E2E tests: spin up the local Planimeter server."""

import pathlib
import socket
import subprocess
import sys
import time

import pytest

ROOT = pathlib.Path(__file__).parent.parent
SERVER_SCRIPT = ROOT / "server.py"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def planimeter_base_url():
    port = _free_port()
    # Reset the backend mirror so the restore-prompt modal does not appear and
    # intercept clicks during E2E. The modal only fires when local is empty AND
    # mirror is non-empty; tests always start with empty localStorage, so a
    # stale mirror from prior runs would block every interaction.
    mirror_path = ROOT / ".planimeter_state_store.json"
    if mirror_path.exists():
        try:
            mirror_path.unlink()
        except OSError:
            pass

    proc = subprocess.Popen(
        [sys.executable, str(SERVER_SCRIPT), "--port", str(port), "--instance-policy", "replace"],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait until server is up (max 10 s)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.2)
    else:
        proc.terminate()
        pytest.fail("Planimeter server did not start in time")

    yield f"http://127.0.0.1:{port}"

    proc.terminate()
    proc.wait(timeout=5)
