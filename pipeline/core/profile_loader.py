# -*- coding: utf-8 -*-
"""
profile_loader.py
-------------------
UI上の「モード」選択を、内部の処理パラメータ群(プロファイル)に変換する。
モードを追加する際は core/profiles/*.yaml を追加するだけでよく、
コード変更は不要な設計。
"""

from __future__ import annotations
import os
import yaml

PROFILES_DIR = os.path.join(os.path.dirname(__file__), "profiles")


class ProfileLoader:
    def __init__(self, profiles_dir: str = PROFILES_DIR):
        self.profiles_dir = profiles_dir

    def available_modes(self) -> list[str]:
        return sorted(
            f[:-5] for f in os.listdir(self.profiles_dir) if f.endswith(".yaml")
        )

    def load(self, mode_name: str) -> dict:
        path = os.path.join(self.profiles_dir, f"{mode_name}.yaml")
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"モード '{mode_name}' のプロファイルが見つかりません: {path}"
            )
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
