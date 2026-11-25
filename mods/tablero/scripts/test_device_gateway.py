import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

import device_gateway as gateway
from device_certificates import create_identity, import_certificate, issue, openssl_binary

OPENSSL = openssl_binary()


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
            with gateway.transaction(folder) as db:
                db.execute("DELETE FROM seen WHERE id=?", (msg["id"],))
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, msg), 409)
            with gateway.transaction(folder) as db:
                self.assertEqual(gateway.receive(db, peer, recipient, dict(msg, project="otro", id="3"*32)), 403)
            self.assertEqual(len(gateway.local(folder, "audit", ["replay"])), 2)
            with self.assertRaises(ValueError):
                gateway.local(folder, "grant", [peer, "demo", "work_request", "read", "2"])
            gateway.local(folder, "link", ["off"])
            self.assertEqual(gateway.local(folder, "snapshot", [])["grants"], [])
            self.assertEqual(len(gateway.local(folder, "snapshot", [])["inbox"]), 1)

    def test_peer_addresses_stay_on_private_ipv4(self):
        self.assertEqual(str(gateway.private_address("192.168.1.4")), "192.168.1.4")
        self.assertEqual(str(gateway.allowed_networks(["10.0.1.0/24"])[0]), "10.0.1.0/24")
        for address in ("0.0.0.0", "1.1.1.1", "localhost", "::1"):
            with self.assertRaises(ValueError):
                gateway.private_address(address)
        for network in ("0.0.0.0/0", "192.168.1.0/8", "1.1.1.1", "::/0"):
            with self.assertRaises(ValueError):
                gateway.allowed_networks([network])

    @unittest.skipUnless(OPENSSL, "openssl required for ephemeral test certificates")
    def test_mtls_pair_requires_local_grant_and_matching_server(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            receptor, emisor = folder / "receptor", folder / "emisor"
            receptor.mkdir()
            emisor.mkdir()
            identidad = create_identity(receptor, True)
            solicitud = create_identity(emisor, False)
            firmado = issue(receptor, solicitud["archivo"], solicitud["huella"])
            local = import_certificate(emisor, firmado["archivo"], firmado["huellaAutoridad"])

            def cfg(identity):
                return dict(ca=identity["ca"], cert=identity["cert"], key=identity["key"],
                            bind="127.0.0.1", port=0, allow=["127.0.0.1"])

            receiver, sender = cfg(identidad), cfg(local)
            gateway.local(folder, "link", ["on"])
            invitation = gateway.local(folder, "invite", [])["code"]
            with gateway.Gateway(receiver, folder) as server:
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    self.assertTrue(gateway.gateway_ready({**receiver, 'port': server.server_port}))
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
