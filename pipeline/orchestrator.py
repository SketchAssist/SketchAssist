# -*- coding: utf-8 -*-
"""
orchestrator.py
----------------
各処理ステージの実行を統括するクラス。

Stage0〜Stage2(背景選択・特徴除去)に加え、
Stage3(エッジ抽出)・Stage4(線の整理)・Stage5(閉領域抽出・データ出力)を扱う。

Stage0〜Stage2(背景選択・特徴除去)と
Stage3(エッジ抽出)までを担当する。
"""

import uuid
import cv2
import numpy as np
from core.stage_pipeline import StageTree, StageNode
from core.profile_loader import ProfileLoader
from core.processors.feature_removal import FeatureRemover
from core.processors.edge_extraction import EdgeExtractor
from core.io_utils import imread_unicode


class Orchestrator:
    def __init__(self, project_dir: str):
        self.tree = StageTree(project_dir)
        self.profile_loader = ProfileLoader()
        self.texture_remover = FeatureRemover()
        self.edge_extractor = EdgeExtractor()

    def run_full_pipeline(
        self,
        input_image_path: str,
        mode: str,
        stage1_include_polygons: list[list[tuple[int, int]]] | None = None,
        stage1_exclude_polygons: list[list[tuple[int, int]]] | None = None,
    ) -> dict:
        profile = self.profile_loader.load(mode)

        orig_img = imread_unicode(input_image_path, cv2.IMREAD_UNCHANGED)
        if orig_img is None:
            raise FileNotFoundError(f"画像が読み込めません: {input_image_path}")

        root_id = str(uuid.uuid4())[:8]
        root_node = StageNode(
            node_id=root_id,
            stage_type="original",
            label="Stage 0: 原本画像",
            params={"mode": mode},
            parent_id=None,
        )
        self.tree.add_node(root_node, orig_img)

        if stage1_include_polygons or stage1_exclude_polygons:
            bg_img = self._apply_stage1_lasso(
                orig_img,
                stage1_include_polygons,
                stage1_exclude_polygons,
            )
            stage1_label = "Stage 1: 投げ縄選択"
            stage1_params = {
                "stage1_method": "lasso",
                "stage1_include_polygons": stage1_include_polygons,
                "stage1_exclude_polygons": stage1_exclude_polygons,
            }
        else:
            bg_img = orig_img.copy()
            stage1_label = "Stage 1: 選択範囲指定(背景除去なし)"
            stage1_params = {}

        s1_id = str(uuid.uuid4())[:8]
        s1_node = StageNode(
            node_id=s1_id,
            stage_type="stage1_selected",
            label=stage1_label,
            params=stage1_params,
            parent_id=root_id,
        )
        self.tree.add_node(s1_node, bg_img)

        tex_params = profile.get("feature_removal", {})
        tex_img = self.texture_remover.process(bg_img, **tex_params)
        s2_id = str(uuid.uuid4())[:8]
        s2_node = StageNode(
            node_id=s2_id,
            stage_type="feature_removed",
            label="Stage 2: 特徴線強調(影・テクスチャ除去)",
            params=tex_params,
            parent_id=s1_id,
        )
        self.tree.add_node(s2_node, tex_img)

        return {"root_id": root_id, "stage1_id": s1_id, "feature_id": s2_id}

    def create_root_node(self, image: np.ndarray, mode: str) -> str:
        root_id = str(uuid.uuid4())[:8]
        root_node = StageNode(
            node_id=root_id,
            stage_type="original",
            label="Stage 0: 原本画像",
            params={"mode": mode},
            parent_id=None,
        )
        self.tree.add_node(root_node, image)
        return root_id

    def create_stage1_node(
        self,
        parent_id: str,
        include_polygons: list[list[tuple[int, int]]] | None = None,
        exclude_polygons: list[list[tuple[int, int]]] | None = None,
    ) -> str:
        self._require_lasso_selection(include_polygons)

        parent_img = self.tree.load_image(parent_id)
        selected_img = self._apply_stage1_lasso(
            parent_img,
            include_polygons,
            exclude_polygons,
        )

        stage1_id = str(uuid.uuid4())[:8]
        stage1_node = StageNode(
            node_id=stage1_id,
            stage_type="stage1_selected",
            label="Stage 1: 投げ縄選択",
            params={
                "lasso_include_polygons": include_polygons,
                "lasso_exclude_polygons": exclude_polygons,
            },
            parent_id=parent_id,
        )
        self.tree.add_node(stage1_node, selected_img)
        return stage1_id

    def create_edge_extraction_node(self, parent_id: str, params: dict) -> str:
        """Stage3: エッジ抽出。背景除去・支持体除去は前提としない。"""
        parent_img = self.tree.load_image(parent_id)
        edge_map = self.edge_extractor.process(parent_img, **params)

        node_id = str(uuid.uuid4())[:8]
        node = StageNode(
            node_id=node_id,
            stage_type="edge_extracted",
            label="Stage 3: エッジ抽出",
            params=params,
            parent_id=parent_id,
        )
        self.tree.add_node(node, edge_map)
        return node_id

    @staticmethod
    def _to_gray(image: np.ndarray) -> np.ndarray:
        """画像をグレースケール(2次元, uint8)に正規化する。
        既にグレースケールで保存されたノード画像はそのまま通す。"""
        if image.ndim == 2:
            return image
        if image.shape[2] == 4:
            image = image[:, :, :3]
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    def advance_stage(
        self,
        node_id: str,
        mode: str,
        stage1_include_polygons: list[list[tuple[int, int]]] | None = None,
        stage1_exclude_polygons: list[list[tuple[int, int]]] | None = None,
    ) -> dict:
        node = self.tree.nodes.get(node_id)
        if node is None:
            raise ValueError(f"ノードが見つかりません: {node_id}")

        profile = self.profile_loader.load(mode)

        if node.stage_type == "original":
            next_node_id = self.create_stage1_node(
                node_id,
                stage1_include_polygons,
                stage1_exclude_polygons,
            )
            return {"node_id": next_node_id}

        if node.stage_type == "stage1_selected":
            tex_params = profile.get("feature_removal", {})
            parent_img = self.tree.load_image(node_id)
            tex_img = self.texture_remover.process(parent_img, **tex_params)
            next_node_id = str(uuid.uuid4())[:8]
            next_node = StageNode(
                node_id=next_node_id,
                stage_type="feature_removed",
                label="Stage 2: 特徴線強調(影・テクスチャ除去)",
                params=tex_params,
                parent_id=node_id,
            )
            self.tree.add_node(next_node, tex_img)
            return {"node_id": next_node_id}

        if node.stage_type == "feature_removed":
            edge_params = profile.get("edge_extraction", {})
            next_node_id = self.create_edge_extraction_node(node_id, edge_params)
            return {"node_id": next_node_id}

        raise ValueError(f"このノードの次のステージへは進めません: {node.stage_type}")

    def branch_from_stage(
        self,
        parent_id: str,
        stage_type: str,
        override_params: dict,
        label: str,
    ) -> dict:
        parent_img = self.tree.load_image(parent_id)
        if parent_img is None:
            raise ValueError(f"親ノードの画像が見つかりません: {parent_id}")

        if stage_type == "stage1_selected":
            include_polygons = override_params.get("lasso_include_polygons")
            exclude_polygons = override_params.get("lasso_exclude_polygons")
            self._require_lasso_selection(include_polygons)
            current_img = self._apply_stage1_lasso(parent_img, include_polygons, exclude_polygons)
        elif stage_type == "feature_removed":
            current_img = self.texture_remover.process(parent_img, **override_params)
        elif stage_type == "edge_extracted":
            current_img = self.edge_extractor.process(parent_img, **override_params)
        else:
            raise ValueError(f"対応していない分岐ステージタイプです: {stage_type}")

        new_id = str(uuid.uuid4())[:8]
        new_node = StageNode(
            node_id=new_id,
            stage_type=stage_type,
            label=label,
            params=override_params,
            parent_id=parent_id,
        )
        self.tree.add_node(new_node, current_img)
        return {"node_id": new_id}

    @staticmethod
    def _require_lasso_selection(include_polygons: list[list[tuple[int, int]]] | None) -> None:
        if not any(len(poly) >= 3 for poly in (include_polygons or [])):
            raise ValueError(
                "Stage1では投げ縄選択(対象領域の指定)が必須です。"
                "投げ縄選択ツールで対象を囲んでから実行してください。"
            )

    @staticmethod
    def _apply_stage1_lasso(
        image: np.ndarray,
        include_polygons: list[list[tuple[int, int]]] | None,
        exclude_polygons: list[list[tuple[int, int]]] | None,
    ) -> np.ndarray:
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        h, w = image.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)

        for poly in (include_polygons or []):
            if len(poly) < 3:
                continue
            pts = np.array(poly, dtype=np.int32).reshape((-1, 1, 2))
            cv2.fillPoly(mask, [pts], 255)

        for poly in (exclude_polygons or []):
            if len(poly) < 3:
                continue
            pts = np.array(poly, dtype=np.int32).reshape((-1, 1, 2))
            cv2.fillPoly(mask, [pts], 0)

        if image.ndim == 3:
            b, g, r = cv2.split(image)
            return cv2.merge([b, g, r, mask])

        b, g, r, _ = cv2.split(image)
        return cv2.merge([b, g, r, mask])