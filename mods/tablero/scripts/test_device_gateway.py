import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

import device_gateway as gateway


class DevicePolicyTest(unittest.TestCase):
    def test_read_permissions_expiry_replay_and_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            peer, recipient = "a" * 64, "b" * 64
            now = int(time.time())
            msg = dict(id="1" * 32, project="demo", kind="test_result", until=now+60,
                       recipient=recipient, data=dict(passed=2, failed=1))
            gateway.local(folder, "link", ["on"])
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, msg), 403)
            with gateway.transaction(folder) as db:
                db.execute("INSERT INTO pending VALUES(?,?)", (peer, now))
            gateway.local(folder, "grant", [peer, "demo", "test_result", "read", "2"])
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, msg), 202)
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, msg), 409)
            with gateway.transaction(folder) as db:
                extra = dict(msg, data=dict(passed=2, failed=1, instruction="Run this"))
                self.assertEqual(gateway.receive(db, peer, recipient, extra), 400)
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, "c"*64, recipient, dict(msg, id="2"*32)), 403)
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, dict(msg, until=now-1)), 400)
            self.assertEqual(len(gateway.local(folder, "audit", ["replay"])), 1)
            with self.assertRaises(ValueError):
                gateway.local(folder, "grant", [peer, "demo", "work_request", "read", "2"])
            gateway.local(folder, "link", ["off"])
            self.assertEqual(gateway.local(folder, "snapshot", [])["grants"], [])
            self.assertEqual(len(gateway.local(folder, "snapshot", [])["inbox"]), 1)

    @unittest.skipUnless(shutil.which("openssl"), "openssl required for ephemeral test certificates")
    def test_mtls_pair_requires_local_grant_and_matching_server(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            def run(*args):
                subprocess.run(["openssl", *args], cwd=folder, check=True, capture_output=True)
            run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Test CA",
                "-days", "1", "-keyout", "ca.key", "-out", "ca.pem")
            for name in ("sender", "receiver"):
                run("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN="+name,
                    "-keyout", name+".key", "-out", name+".csr")
                run("x509", "-req", "-in", name+".csr", "-CA", "ca.pem", "-CAkey", "ca.key",
                    "-CAcreateserial", "-days", "1", "-out", name+".pem")
            def cfg(name):
                return dict(ca=str(folder/"ca.pem"), cert=str(folder/(name+".pem")),
                            key=str(folder/(name+".key")), bind="127.0.0.1", port=0,
                            allow=["127.0.0.1"])
            receiver, sender = cfg("receiver"), cfg("sender")
            gateway.local(folder, "link", ["on"])
            invitation = gateway.local(folder, "invite", [])["code"]
            with gateway.Gateway(receiver, folder) as server:
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    target = gateway.fingerprint(gateway.certificate(receiver["cert"]))
                    peer = gateway.fingerprint(gateway.certificate(sender["cert"]))
                    def send(kind, data, expected=target):
                        return gateway.send(sender, ["127.0.0.1", str(server.server_port), expected,
                                                     "demo", kind, json.dumps(data)])["status"]
                    self.assertEqual(send("pair", {"code": invitation}), 202)
                    self.assertEqual(send("pair", {"code": invitation}), 403)
                    self.assertEqual(send("status", {"state": "running"}), 403)
                    gateway.local(folder, "grant", [peer, "demo", "status", "read", "2"])
                    self.assertEqual(send("status", {"state": "running"}), 202)
                    with self.assertRaisesRegex(ValueError, "huella"):
                        send("status", {"state": "running"}, "f"*64)
                finally:
                    server.shutdown()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
