# -*- coding: utf-8 -*-
"""
edge_extraction.py
--------------------
Stage 3: エッジ抽出エンジン。

方針:
  - 背景除去・支持体除去・模様除去などを一切前提としない。入力画像
    (Stage2までの出力)を「そのまま」対象にエッジを検出する。
  - できるだけ多くのエッジを取得することを優先する(再現率優先)。
    AIによる重要度判定・昆虫認識・被写体分離などは一切行わない
    (それらは次段階で実装する)。
  - 「線の削除」はこのステージの責務ではない。ノイズの間引きや
    重要度による取捨選択はStage4以降(または将来の学術図版生成段階)
    で行う。

アルゴリズム概要:
  複数チャンネル(グレースケール・B・G・R)×複数スケール(ぼかし量)で
  Canny法によるエッジ検出を行い、その一致回数(投票数)を正規化した
  「投票強度マップ」を基本とする。
  さらに、Cannyのヒステリシスで弱すぎるとして捨てられてしまう
  微弱なエッジも失わないよう、各チャンネルの正規化済み勾配強度
  (Sobel)の最大値を弱い重みで加算し、最終的な「エッジ強度マップ」
  (uint8, 0-255の連続値)として出力する。

  二値化はここでは行わない(情報量を落とさないため)。二値化・
  ギャップ接続・孤立点除去はStage4(line_integration)の責務とする。
"""

from __future__ import annotations
import numpy as np
import cv2


class EdgeExtractor:
    def process(
        self,
        image: np.ndarray,
        canny_sigmas: tuple[float, ...] = (0.0, 1.0, 2.0),
        canny_auto_sigma: float = 0.33,
        include_color_channels: bool = True,
        gradient_boost_weight: float = 0.35,
        gradient_clip_percentile: float = 99.0,
        **_ignored,
    ) -> np.ndarray:
        """
        画像から「エッジ強度マップ」(uint8, 1chグレースケール)を生成する。

        canny_sigmas       : マルチスケール検出に使うガウスぼかしのsigma値の集合。
                              0.0は元解像度のまま(微細なエッジ用)、値が大きいほど
                              粗い構造のエッジを拾う。
        canny_auto_sigma    : 中央値ベースの自動閾値算出に使う許容幅(OpenCVでよく
                              使われる auto-Canny の慣例値)。
        include_color_channels: True の場合、グレースケールに加えてB/G/Rチャンネル
                              個別にも検出する(色は同じでも輝度が近い境界を拾う
                              ため。逆に輝度は同じでも色相が変わる境界を拾える)。
        gradient_boost_weight: Cannyの多数決だけでは検出されなかった微弱なエッジを
                              救済するための、正規化済み勾配強度の重み(0〜1)。
        gradient_clip_percentile: 勾配強度を0-255へ正規化する際の外れ値クリップ
                              パーセンタイル。

        画像にアルファチャンネルがある場合(Stage1の投げ縄選択で除外された
        領域がalpha=0になっている場合)、その領域は処理対象から除外する
        (エッジを検出しない・統計量の計算にも含めない)。
        """
        mask = self._extract_mask(image)
        channels = self._build_channels(image, include_color_channels)
        if mask is not None:
            channels = [self._fill_outside_mask(ch, mask) for ch in channels]

        h, w = channels[0].shape
        vote_map = np.zeros((h, w), dtype=np.float32)
        grad_map = np.zeros((h, w), dtype=np.float32)
        n_passes = 0

        for ch in channels:
            ch_f64 = ch.astype(np.float64)
            for sigma in canny_sigmas:
                blurred = (
                    cv2.GaussianBlur(ch, (0, 0), sigmaX=sigma)
                    if sigma > 0
                    else ch
                )
                low, high = self._auto_canny_thresholds(blurred, canny_auto_sigma, mask)
                edges = cv2.Canny(blurred, low, high)
                vote_map += (edges > 0).astype(np.float32)
                n_passes += 1

            # 勾配強度(このチャンネルでの最大値を後で全チャンネル分と統合)
            gx = cv2.Sobel(ch_f64, cv2.CV_64F, 1, 0, ksize=3)
            gy = cv2.Sobel(ch_f64, cv2.CV_64F, 0, 1, ksize=3)
            mag = np.hypot(gx, gy).astype(np.float32)
            grad_map = np.maximum(grad_map, mag)

        vote_strength = (vote_map / max(1, n_passes)) * 255.0

        # 勾配強度を0-255へクリップ正規化(外れ値による圧縮を防ぐ。
        # 除外領域はここでの統計にも含めない)
        grad_for_percentile = grad_map[mask] if mask is not None else grad_map
        clip_val = float(np.percentile(grad_for_percentile, gradient_clip_percentile))
        clip_val = max(clip_val, 1e-6)
        grad_norm = np.clip(grad_map / clip_val, 0, 1) * 255.0

        edge_strength = np.maximum(vote_strength, grad_norm * gradient_boost_weight)
        edge_strength = np.clip(edge_strength, 0, 255).astype(np.uint8)

        if mask is not None:
            edge_strength[~mask] = 0

        return edge_strength

    @staticmethod
    def _extract_mask(image: np.ndarray) -> np.ndarray | None:
        """アルファチャンネルがあれば、投げ縄で選択された領域(alpha>0)の
        真偽値マスクを返す。無ければNone(=画像全体を対象とする)。"""
        if image.ndim == 3 and image.shape[2] == 4:
            return image[:, :, 3] > 0
        return None

    @staticmethod
    def _fill_outside_mask(channel: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """マスク外(投げ縄で除外された領域)を、マスク内の平均値で埋める。

        除外領域に残っている元画像の色をそのまま使うと、無関係な背景・
        支持体の勾配がエッジ検出やCannyの自動閾値算出(中央値ベース)に
        混入してしまうため、マスク内の平均的な値で塗りつぶして影響を断つ。
        (最終的な出力自体はこの後マスク外を明示的に0にするため、
        ここでの塗りつぶし値そのものがエッジとして残ることはない。)
        """
        out = channel.copy()
        if mask.any():
            fill_value = int(channel[mask].mean())
        else:
            fill_value = 0
        out[~mask] = fill_value
        return out

    @staticmethod
    def _build_channels(image: np.ndarray, include_color_channels: bool) -> list[np.ndarray]:
        if image.ndim == 2:
            bgr = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            bgr = image[:, :, :3]
        else:
            bgr = image

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        channels = [gray]
        if include_color_channels:
            b, g, r = cv2.split(bgr)
            channels.extend([b, g, r])
        return channels

    @staticmethod
    def _auto_canny_thresholds(
        gray_u8: np.ndarray, sigma: float, mask: np.ndarray | None = None
    ) -> tuple[int, int]:
        """中央値ベースでCannyの閾値を自動算出する(auto-Cannyの定石)。
        mask が指定された場合、中央値の計算はmask内の画素のみを対象とする。"""
        sample = gray_u8[mask] if mask is not None and mask.any() else gray_u8
        median = float(np.median(sample))
        lower = int(max(0, (1.0 - sigma) * median))
        upper = int(min(255, (1.0 + sigma) * median))
        if upper <= lower:
            upper = lower + 1
        return lower, upper