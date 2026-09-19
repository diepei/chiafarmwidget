from __future__ import annotations

import argparse
import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

import yaml
from fastapi import Depends, FastAPI, Header, HTTPException, Response

from .collector import collect
from .baseline import FarmBaseline
from .config import Settings


logger = logging.getLogger(__name__)


class State:
    data: dict = {"status": "critical", "alerts": [{"severity": "critical", "message": "Agent is starting"}]}


def create_config(path: str, chia_root: str) -> str:
    destination = Path(path).expanduser()
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite {destination}")
    token = secrets.token_urlsafe(32)
    payload = {
        "host": "127.0.0.1",
        "port": 8926,
        "api_token": token,
        "chia_root": str(Path(chia_root).expanduser()),
        "refresh_seconds": 30,
        "activity_stale_seconds": 300,
        "rpc_debug": False,
        "disks": [],
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(yaml.safe_dump(payload, sort_keys=False))
    return token


def create_app(settings: Settings, baseline: FarmBaseline | None = None) -> FastAPI:
    state = State()

    async def refresh() -> None:
        while True:
            try:
                state.data = await collect(settings, baseline)
            except Exception as exc:
                logger.exception("Farm collection failed")
                state.data = {"status": "critical", "alerts": [{"severity": "critical", "message": "Collection failed"}], "error": str(exc)}
            await asyncio.sleep(settings.refresh_seconds)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = asyncio.create_task(refresh())
        await asyncio.sleep(0)
        yield
        task.cancel()

    app = FastAPI(title="Chia Monitor Agent", docs_url=None, redoc_url=None, lifespan=lifespan)
    def authorize(authorization: Optional[str] = Header(default=None)) -> None:
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not secrets.compare_digest(supplied, settings.api_token):
            raise HTTPException(status_code=401, detail="Invalid API token")

    @app.get("/healthz")
    async def healthz(): return {"ok": True}

    @app.get("/api/widget", dependencies=[Depends(authorize)])
    async def widget(response: Response):
        # The widget endpoint is a live heartbeat. It must never be satisfied
        # by an HTTP cache after the miner or agent has gone offline.
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        d = state.data
        farm = d.get("farm", {})
        disks = d.get("disks", [])
        return {"status": d.get("status", "critical"), "farmer": d.get("farmer", {}).get("online", False), "synced": d.get("node", {}).get("synced", False), "plots": farm.get("plots", 0), "tib": farm.get("size_tib", 0), "failed_plots": farm.get("failed_plots", 0), "harvesters": d.get("harvesters", {}), "disks": {"online": sum(1 for disk in disks if disk.get("online")), "total": len(disks)}, "etw_seconds": farm.get("estimated_time_to_win_seconds", 0), "estimated_daily_xch": d.get("farming", {}).get("estimated_daily_xch", 0), "blocks_won": d.get("farming", {}).get("blocks_won", 0), "last_block_height": d.get("farming", {}).get("last_block_height", 0), "last_block_at": d.get("farming", {}).get("last_block_at"), "alerts": d.get("alerts", [])[:3], "baseline": d.get("baseline", {}), "rpc_errors": d.get("rpc_errors", {}), "updated_at": d.get("updated_at")}

    return app


def run() -> None:
    parser = argparse.ArgumentParser(description="Chia Monitor agent")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--init-config", action="store_true", help="create a secure starter configuration and exit")
    parser.add_argument("--reset-baseline", action="store_true", help="forget learned farm capacity and learn it again")
    parser.add_argument("--chia-root", default="~/.chia/mainnet", help="Chia root used with --init-config")
    args = parser.parse_args()
    if args.init_config:
        try:
            token = create_config(args.config, args.chia_root)
        except FileExistsError as exc:
            parser.error(str(exc))
        print(f"Configuration created: {Path(args.config).expanduser()}")
        print(f"Scriptable API token: {token}")
        print("Save this token now; it is required by the iPhone widget.")
        return
    if args.reset_baseline:
        state_path = Path(args.config).expanduser().resolve().parent / "state.json"
        state_path.unlink(missing_ok=True)
        print(f"Farm baseline reset: {state_path}")
        print("Restart the Chia Monitor Agent scheduled task to begin learning again.")
        return
    settings = Settings.load(args.config)
    config_directory = Path(args.config).expanduser().resolve().parent
    log_path = config_directory / "chia-monitor.log"
    handler = RotatingFileHandler(log_path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG if settings.rpc_debug else logging.INFO)
    root_logger.addHandler(handler)
    logger.info("Starting Chia Monitor root=%s host=%s port=%s rpc_debug=%s", settings.root, settings.host, settings.port, settings.rpc_debug)
    baseline = FarmBaseline(config_directory / "state.json")
    import uvicorn
    uvicorn.run(create_app(settings, baseline), host=settings.host, port=settings.port, access_log=False)


if __name__ == "__main__": run()
