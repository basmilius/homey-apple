__version__ = "0.13.2"

# This file is dual licensed under the terms of the Apache License, Version
# 2.0, and the BSD License. See the LICENSE file in the root of this repository
# for complete details.

from cryptography.hazmat.primitives.ciphers.aead import (
    ChaCha20Poly1305 as ChaCha20Poly1305Reusable,
)

__all__ = ["ChaCha20Poly1305Reusable"]
