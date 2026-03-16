from __future__ import annotations

import json
from typing import Any

from homey import Homey
from pyatv.storage import AbstractStorage, StorageModel

SETTINGS_KEY = "pyatv_storage"


class AppSettingsStorage(AbstractStorage):
    """
    Persistent pyatv storage backed by Homey's settings API.

    All device credentials and protocol settings are serialized to JSON
    and stored in a single Homey setting under the key ``pyatv_storage``.
    """

    def __init__(self, homey: Homey) -> None:
        super().__init__()
        self._homey = homey

    async def save(self) -> None:
        """Persist the current storage model to Homey settings."""
        data = dict(self)
        if not self.has_changed(data):
            return

        await self._homey.settings.set(SETTINGS_KEY, json.dumps(data))
        self.update_hash(data)

    async def load(self) -> None:
        """Load the storage model from Homey settings."""
        raw: Any = self._homey.settings.get(SETTINGS_KEY)

        if raw is None:
            return

        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            self.storage_model = StorageModel.model_validate(parsed)
        except Exception as err:
            self._homey.log('pyatv storage data is corrupt, starting fresh:', err)
            return

        self.update_hash(dict(self))
