"""Pytest fixtures for E2E tests: spin up the local Planimeter server."""

import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
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
    # Isolate backend mirror in a temporary directory so the user's real
    # .planimeter_state_store.json is never touched and the restore-prompt modal
    # does not appear during clean-slate E2E tests.
    tmp_dir = tempfile.mkdtemp(prefix="planimeter_e2e_session_")
    env = {
        **os.environ,
        "PLANIMETER_STATE_STORE_FILE": str(pathlib.Path(tmp_dir) / "state_store.json"),
        "PLANIMETER_CULTIVAR_STORE_FILE": str(pathlib.Path(tmp_dir) / "cultivars.json"),
        "PLANIMETER_HISTORY_STORE_FILE": str(pathlib.Path(tmp_dir) / "history.json"),
    }

    proc = subprocess.Popen(
        [sys.executable, str(SERVER_SCRIPT), "--port", str(port), "--no-browser", "--instance-policy", "replace"],
        cwd=str(ROOT),
        env=env,
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
        shutil.rmtree(tmp_dir, ignore_errors=True)
        pytest.fail("Planimeter server did not start in time")

    yield f"http://127.0.0.1:{port}"

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(tmp_dir, ignore_errors=True)
