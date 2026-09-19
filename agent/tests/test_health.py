import asyncio
from unittest.mock import patch

from chia_monitor.collector import BLOCKS_PER_YEAR, _block_reward_xch, _disk_status, collect
from chia_monitor.config import DiskConfig, Settings
from chia_monitor.main import create_app, create_config
from fastapi.testclient import TestClient


def test_settings_expand_home():
    settings = Settings(api_token="a" * 32)
    assert settings.root.is_absolute()


def test_missing_disk_is_offline():
    result = _disk_status([DiskConfig(name="missing", mountpoint="/path/that/cannot/exist")])
    assert result[0]["online"] is False


def test_farm_data_requires_token():
    client = TestClient(create_app(Settings(api_token="a" * 32)))
    assert client.get("/api/widget").status_code == 401
    response = client.get("/api/widget", headers={"Authorization": f"Bearer {'a' * 32}"})
    assert response.status_code == 200
    payload = response.json()
    assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"
    assert response.headers["pragma"] == "no-cache"
    assert set(("status", "plots", "alerts", "estimated_daily_xch", "last_block_at")) <= payload.keys()
    assert "score" not in payload
    assert "balance_xch" not in payload


def test_create_config_generates_token(tmp_path):
    path = tmp_path / "config.yaml"
    token = create_config(str(path), "/home/chia/.chia/mainnet")
    assert len(token) >= 32
    assert token in path.read_text()


def test_chia_273_rpc_payload_produces_live_farm_status():
    plot_size = round(32.17 * 2**40 / 325)

    async def rpc_call(_service, method, _body=None):
        responses = {
            "get_blockchain_state": {"success": True, "blockchain_state": {"sync": {"sync_mode": False, "synced": True}, "space": plot_size * 325 * 38, "peak": {"height": 123}}},
            "get_connections": {"success": True, "connections": []},
            "get_harvesters": {"success": True, "harvesters": [{"plots": [{"file_size": plot_size} for _ in range(325)]}]},
            "get_plots": {"success": True, "plots": [{"file_size": plot_size} for _ in range(325)], "failed_to_open_filenames": [], "not_found_filenames": []},
            "get_farmed_amount": {"success": True, "farmed_amount": 5_654_309_000_000, "blocks_won": 4, "last_height_farmed": 7_000_000, "last_time_farmed": 1_760_000_000},
        }
        return responses[method]

    with patch("chia_monitor.collector.ChiaRPC") as rpc_class:
        rpc_class.return_value.call.side_effect = rpc_call
        result = asyncio.run(collect(Settings(api_token="a" * 32)))

    assert result["farmer"]["online"] is True
    assert result["node"]["synced"] is True
    assert result["farm"]["plots"] == 325
    assert result["farm"]["size_tib"] == 32.17
    assert result["harvesters"] == {"online": 1, "total": 1}
    assert result["farming"]["blocks_won"] == 4
    assert result["farming"]["last_block_height"] == 7_000_000
    assert result["farming"]["last_block_at"] == "2025-10-09T08:53:20+00:00"
    assert result["farming"]["estimated_daily_xch"] > 0
    assert not {"farmer_offline", "node_sync"} & {alert["code"] for alert in result["alerts"]}


def test_chia_block_reward_halving_schedule():
    assert _block_reward_xch(0) == 2.0
    assert _block_reward_xch(3 * BLOCKS_PER_YEAR) == 1.0
    assert _block_reward_xch(6 * BLOCKS_PER_YEAR) == 0.5
    assert _block_reward_xch(9 * BLOCKS_PER_YEAR) == 0.25
    assert _block_reward_xch(12 * BLOCKS_PER_YEAR) == 0.125
