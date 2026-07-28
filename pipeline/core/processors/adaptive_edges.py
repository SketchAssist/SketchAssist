# -*- coding: utf-8 -*-
"""
adaptive_edges.py

Cannyのエッジ検出閾値を画像全体で固定するのではなく、タイルごとの
局所的なコントラスト（標準偏差）に応じて自動調整する。
低コントラストな領域（滑らかな陰影の境目など）では閾値を下げて
線を拾いやすくし、高コントラストな領域では閾値を上げてノイズの
増加を抑える。

Stage 4（ベクトル化）の前段、あるいは既存のCanny処理の置き換え候補として
使うことを想定した独立モジュール。line_graph.py / region_extraction.py には
依存しない。
"""

import numpy as np
import cv2


def adaptive_canny(gray: np.ndarray,
                    tile_size: int = 80,
                    stride: int = 40,
                    k_high: float = 1.2,
                    k_low: float = 0.5,
                    min_high: float = 20.0,
                    max_high: float = 200.0,
                    blur_ksize: int = 3) -> np.ndarray:
    """
    タイルごとの局所コントラスト（標準偏差）に応じて閾値を変えながらCannyを適用する。

    引数:
        gray       : グレースケール画像 (uint8)
        tile_size  : タイルの一辺の大きさ(px)
        stride     : タイルをずらす幅(px)。tile_size より小さくして重複させることで、
                     タイルの境界にできる不連続を緩和する
        k_high/k_low: 閾値 = k * タイル内の標準偏差、という比例係数
        min_high/max_high: 閾値の下限・上限（極端な値を避けるクリップ）
        blur_ksize : 事前のガウシアンぼかしのカーネルサイズ

    戻り値:
        2値のエッジ画像 (uint8, 0/255)。重複するタイル間は論理和(OR)で合成する。
    """
    h, w = gray.shape
    result = np.zeros((h, w), dtype=np.uint8)
    blurred = cv2.GaussianBlur(gray, (blur_ksize, blur_ksize), 0)

    for y0 in range(0, h, stride):
        y1 = min(h, y0 + tile_size)
        if y1 - y0 < 10:
            continue
        for x0 in range(0, w, stride):
            x1 = min(w, x0 + tile_size)
            if x1 - x0 < 10:
                continue

            tile = blurred[y0:y1, x0:x1]
            std = float(np.std(tile))

            high = float(np.clip(k_high * std, min_high, max_high))
            low = float(np.clip(k_low * std, min_high * 0.2, high * 0.6))

            edges_tile = cv2.Canny(tile, int(low), int(high))
            region = result[y0:y1, x0:x1]
            result[y0:y1, x0:x1] = np.maximum(region, edges_tile)

    return result