"""Process-identity checks only; no Tk window, process, service or input starts."""
from pathlib import Path
import unittest

from companion import verified_backend_identity


VENV = str(Path(r"C:\Wasla\venv\Scripts\python.exe"))
BASE = str(Path(r"C:\Python311\python.exe"))
COMMAND = [VENV, "-u", "-m", "wasla", "serve", "--state", r"C:\Wasla\private",
           "--host", "100.72.126.108", "--port", "47621", "--stdin-control"]


class FakeProcess:
    def __init__(self, pid, parent, exe, command, created):
        self.pid, self.parent, self.executable = pid, parent, exe
        self.arguments, self.created, self.running = list(command), created, True

    def ppid(self): return self.parent
    def exe(self): return self.executable
    def cmdline(self): return self.arguments
    def create_time(self): return self.created
    def is_running(self): return self.running


class CompanionOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.processes = {
            100: FakeProcess(100, 50, VENV, COMMAND, 1000.0),
            101: FakeProcess(101, 100, BASE, [BASE, *COMMAND[1:]], 1000.1),
        }

    def verify(self, pid=101):
        return verified_backend_identity(100, 1000.0, pid, COMMAND, BASE,
                                         process_factory=self.processes.__getitem__)

    def test_exact_direct_base_interpreter_child_is_accepted(self):
        identity = self.verify()
        self.assertEqual(identity.pid, 101)
        self.assertEqual(identity.created_at, 1000.1)

    def test_non_redirected_owned_interpreter_is_accepted(self):
        self.assertEqual(self.verify(100).pid, 100)

    def test_sibling_or_unrelated_process_is_rejected(self):
        self.processes[101].parent = 50
        self.assertIsNone(self.verify())

    def test_grandchild_is_not_implicitly_trusted(self):
        self.processes[101].parent = 102
        self.assertIsNone(self.verify())

    def test_wrong_executable_is_rejected_even_with_expected_cli(self):
        self.processes[101].executable = r"C:\Other\python.exe"
        self.assertIsNone(self.verify())

    def test_other_private_state_is_rejected(self):
        self.processes[101].arguments[6] = r"C:\Other\private"
        self.assertIsNone(self.verify())

    def test_additional_or_modified_server_flags_are_rejected(self):
        self.processes[101].arguments.append("--allow-desktop")
        self.assertIsNone(self.verify())

    def test_reused_launcher_pid_is_rejected(self):
        self.processes[100].created = 1100.0
        self.assertIsNone(self.verify())

    def test_child_predating_launcher_is_rejected(self):
        self.processes[101].created = 999.0
        self.assertIsNone(self.verify())

    def test_disappeared_or_stopped_process_is_rejected(self):
        self.assertIsNone(self.verify(999))
        self.processes[101].running = False
        self.assertIsNone(self.verify())

    def test_forged_bool_pid_is_rejected(self):
        self.assertIsNone(self.verify(True))

    def test_launcher_command_must_also_match(self):
        self.processes[100].arguments[3] = "other_module"
        self.assertIsNone(self.verify())


if __name__ == "__main__":
    unittest.main()
