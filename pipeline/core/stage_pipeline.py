# -*- coding: utf-8 -*-
"""
stage_pipeline.py
----------------
画像処理パイプラインの各ステージ(ノード)および
それらを管理する非循環グラフ(木構造)のデータ構造の定義。
画像I/Oを日本語パス対応版に強化。
"""

from __future__ import annotations
import json
import os
import cv2
import numpy as np
from core.io_utils import imread_unicode, imwrite_unicode, write_text_unicode, read_text_unicode


class StageNode:
    """パイプラインの特定の処理状態(成果物)を表すクラス。"""

    def __init__(
        self,
        node_id: str,
        stage_type: str,
        label: str,
        params: dict,
        parent_id: str | None = None,
        image_filename: str | None = None,
        extra_files: dict[str, str] | None = None,
    ):
        self.id = node_id
        self.stage_type = stage_type  # 'stage1_selected', 'feature_removed', 'edge_extracted' など
        self.label = label            # UI表示用の名前
        self.params = params          # このステージで使用したパラメータの複製
        self.parent_id = parent_id    # 親ノードのID (分岐元の追跡用)
        self.image_filename = image_filename  # ディスクに保存された中間画像(プレビュー用ラスタ)のファイル名
        self.extra_files = extra_files or {}  # 画像以外の成果物(例: {"svg": "xxx.svg", "polylines_json": "xxx.json"})

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "stage_type": self.stage_type,
            "label": self.label,
            "params": self.params,
            "parent_id": self.parent_id,
            "image_filename": self.image_filename,
            "extra_files": self.extra_files,
        }

    @classmethod
    def from_dict(cls, d: dict) -> StageNode:
        return cls(
            node_id=d["id"],
            stage_type=d["stage_type"],
            label=d["label"],
            params=d["params"],
            parent_id=d["parent_id"],
            image_filename=d["image_filename"],
            extra_files=d.get("extra_files", {}),
        )


class StageTree:
    """ステージ間の親子関係・分岐構造を管理し、ディスク保存を制御するクラス。"""

    def __init__(self, project_dir: str):
        self.project_dir = project_dir
        self.nodes_dir = os.path.join(project_dir, "nodes")
        self.manifest_path = os.path.join(project_dir, "project_manifest.json")
        self.nodes: dict[str, StageNode] = {}
        self.root_id: str | None = None

        os.makedirs(self.nodes_dir, exist_ok=True)
        self.load_project()

    def add_node(self, node: StageNode, image: np.ndarray | None = None) -> str:
        """ツリーに新しいステージを追加し、画像があればディスクに保存する。"""
        if image is not None:
            filename = f"{node.id}.png"
            filepath = os.path.join(self.nodes_dir, filename)
            # 日本語パスでも安全に保存できるように修正
            if not imwrite_unicode(filepath, image):
                raise IOError(
                    f"画像ファイルの保存に失敗しました: {filepath}\n"
                    f"  ノード: {node.id}  ステージ: {node.stage_type}\n"
                    f"  nodes_dir: {self.nodes_dir}"
                )
            node.image_filename = filename

        self.nodes[node.id] = node
        if node.parent_id is None:
            self.root_id = node.id

        self.save_project()
        return node.id

    def load_image(self, node_id: str) -> np.ndarray:
        """指定したノードの中間画像をディスクから読み込む。"""
        node = self.nodes.get(node_id)
        if not node or not node.image_filename:
            raise FileNotFoundError(f"ノード {node_id} の画像が見つかりません。")
        filepath = os.path.join(self.nodes_dir, node.image_filename)
        # 日本語パスでも安全に読み込めるように修正
        img = imread_unicode(filepath, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise IOError(f"画像の読み込みに失敗しました: {filepath}")
        return img

    def get_children(self, parent_id: str) -> list[StageNode]:
        """特定のノードから派生(分岐)した子ノードの一覧を取得する。"""
        return [n for n in self.nodes.values() if n.parent_id == parent_id]

    def save_extra_file(self, node_id: str, key: str, filename: str, content: str) -> None:
        """画像以外の成果物(SVG・JSON等のテキストデータ)をノードに紐づけて保存する。

        key は "svg" "polylines_json" のように成果物の種類を表す任意の識別子。
        同じノードに複数の成果物(SVGとJSONなど)を保存できる。
        """
        node = self.nodes.get(node_id)
        if node is None:
            raise ValueError(f"ノードが見つかりません: {node_id}")
        filepath = os.path.join(self.nodes_dir, filename)
        if not write_text_unicode(filepath, content):
            raise IOError(f"成果物の保存に失敗しました: {filepath}")
        node.extra_files[key] = filename
        self.save_project()

    def load_extra_file(self, node_id: str, key: str) -> str:
        """save_extra_file() で保存した成果物を読み込む。"""
        node = self.nodes.get(node_id)
        if node is None or key not in node.extra_files:
            raise FileNotFoundError(f"ノード {node_id} に成果物 '{key}' が見つかりません。")
        filepath = os.path.join(self.nodes_dir, node.extra_files[key])
        content = read_text_unicode(filepath)
        if content is None:
            raise IOError(f"成果物の読み込みに失敗しました: {filepath}")
        return content

    def save_project(self):
        """プロジェクト全体の構造をマニフェストファイル(JSON)に保存する。"""
        # ディレクトリが消えていても復元できるよう保険的に作成する
        os.makedirs(self.nodes_dir, exist_ok=True)
        manifest = {
            "root_id": self.root_id,
            "nodes": {nid: node.to_dict() for nid, node in self.nodes.items()}
        }
        with open(self.manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=4)

    def load_project(self):
        """過去の保存データがあればマニフェストからツリー構造を復元する。"""
        if not os.path.exists(self.manifest_path):
            return
        try:
            with open(self.manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            self.root_id = manifest.get("root_id")
            for nid, ndict in manifest.get("nodes", {}).items():
                self.nodes[nid] = StageNode.from_dict(ndict)
        except Exception:
            # 破損している場合は新規とみなす
            pass