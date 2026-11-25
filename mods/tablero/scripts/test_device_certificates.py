import json
from pathlib import Path
import tempfile
import unittest

import device_certificates as certs
import device_gateway as gateway


@unittest.skipUnless(certs.openssl_binary(), "requiere OpenSSL")
class CertificateWizardTest(unittest.TestCase):
    def test_pair_issues_only_public_data_and_preserves_requesting_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "first", Path(tmp) / "second"
            a.mkdir()
            b.mkdir()
            ca = certs.create_identity(a, True)
            request = certs.create_identity(b, False)
            key = b / certs.IDENTITY / "device.key"
            original = key.read_bytes()
            self.assertEqual(request, certs.create_identity(b, False))
            self.assertEqual(original, key.read_bytes())
            self.assertNotIn(b"PRIVATE KEY", Path(request["archivo"]).read_bytes())

            with self.assertRaisesRegex(ValueError, "solicitud cambió"):
                certs.issue(a, request["archivo"], "0" * 64)
            response = certs.issue(a, request["archivo"], request["huella"])
            data = Path(response["archivo"]).read_text("utf-8")
            self.assertEqual(set(json.loads(data)), {"certificado", "autoridad"})
            self.assertNotIn("PRIVATE KEY", data)
            with self.assertRaisesRegex(ValueError, "huella de la CA"):
                certs.import_certificate(b, response["archivo"], "0" * 64)
            target = certs.import_certificate(b, response["archivo"], response["huellaAutoridad"])
            self.assertEqual(original, key.read_bytes())
            gateway.check_identity([target["cert"], target["key"], target["ca"]])
            self.assertEqual(Path(ca["ca"]).read_bytes(), Path(target["ca"]).read_bytes())
            self.assertEqual(certs.create_identity(b, False), target)
            with self.assertRaisesRegex(ValueError, "existentes"):
                certs.import_certificate(b, response["archivo"], response["huellaAutoridad"])


if __name__ == "__main__":
    unittest.main()
