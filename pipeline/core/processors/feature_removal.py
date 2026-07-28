# -*- coding: utf-8 -*-
"""
feature_removal.py
--------------------
Stage 2: 特徴除去。

モードごとの「保持すべき構造」「除去すべきノイズ」に応じて、
テクスチャ・陰影・ハイライト反射・斑紋を選択的に平滑化/除去する。

設計方針(2026-07 photometric_filters統合により全面改訂):
  すべての輝度系処理(陰影補正・ハイライト抑制・陰影持ち上げ・
  テクスチャ平滑化・局所コントラスト調整)は HSV の V チャンネル
  (float32, 0-255)に対して core.processors.photometric_filters の
  関数群をそのまま適用し、H/S(色相・彩度)は変更しない。
  これにより輝度操作による色かぶりを避けつつ、アルゴリズムの実体を
  photometric_filters 側に一本化し、以後の挙動変更・チューニングは
  そちらだけを見ればよい状態にしている。

  従来 cv2.GaussianBlur / cv2.bilateralFilter で個別実装していた
  陰影補正・テクスチャ平滑化は、重複する処理として
  photometric_filters.shadow_normalize_full_image /
  photometric_filters.bilateral_filter_full に置き換えた
  (cv2.bilateralFilterよりは低速だが、アルゴリズムの一貫性を優先)。

除去強度:
  各 *_strength はプロファイル上限値(ceiling)として扱い、
  実際に適用する強度は画像自体の統計量から auto_strength で自動算出する
  (既定で有効)。photometric_filters の各関数自体は「強度」引数を
  持たない(数式に内蔵)ため、ここでは「処理前V」と「処理後V」を
  strengthで線形ブレンドすることで強度調整を行う。

  陰影補正(shadow_removal_strength)と背景残渣除去
  (background_residue_strength)は、以前は同じ強度パラメータを共有して
  いたが、片方の調整がもう片方に連動してしまう問題があったため分離した。
  それぞれ独立した画像統計量(前者は画像全体のV分散、後者は前景境界帯の
  V分散)から自動算出する。

  [2026-07 修正] 深い陰影の持ち上げ(shadow_lift, 亀裂・関節部・縫合線など)
  は、以前は suppress リストへの明示的な指定("deep_shadow_crevice")が
  必要なオプトイン処理だったが、常時適用する処理に変更した(陰影は関節部を
  含めてすべてStage2で持ち上げておく方針のため)。合わせて自動強度算出も、
  画像全体に対する陰影画素の「割合」ではなく、陰影の連結成分ごとの
  「深さ」を見る指標に変更した。関節部の陰影は画像全体からすれば面積が
  小さいため、割合ベースの指標では強度が低く出てしまい、狭くても深い
  陰影が十分に持ち上がらない問題があったため。

対象領域への限定(2026-07):
  画像にアルファチャンネルがある場合(Stage1の投げ縄選択で除外された
  領域がalpha=0になっている場合)、その領域は一切処理しない
  (統計量の計算にも含めない)。除外領域の色がそのまま処理に混入し、
  意図しない補正がかかることを防ぐ。

パフォーマンス(2026-07):
  bilateral_filter_full はフルサイズ画像に対してカーネル半径分の
  numpy演算を繰り返すため、投げ縄選択領域が画像の一部にしか写っていない
  場合、対象領域外の計算が無駄になる。_bilateral_filter_masked() で
  マスクの外接矩形(+カーネル半径分の余白)だけに絞って実行し、結果を
  元のキャンバスへ貼り戻すことで、数値的な挙動を変えずに計算量を減らす。
"""

from __future__ import annotations
import numpy as np
import cv2

from core.processors.photometric_filters import (
    shadow_normalize_full_image,
    suppress_highlights_regional,
    lift_shadows,
    local_contrast_equalize,
    bilateral_filter_full,
    bilateral_filter_radius,
)


class FeatureRemover:
    def process(
        self,
        image: np.ndarray,
        texture_removal_strength: float = 0.5,
        shadow_removal_strength: float = 0.5,
        highlight_suppression_strength: float = 0.0,
        shadow_lift_strength: float = 0.5,
        local_contrast_strength: float = 0.0,
        background_residue_strength: float = 0.5,
        pattern_k: int | None = None,
        pattern_k_min: int = 2,
        pattern_k_max: int = 8,
        suppress: list[str] | None = None,
        auto_strength: bool = True,
        **_ignored,
    ) -> np.ndarray:
        """
        suppress リストの内容に応じて必要な除去処理を順に適用する。
        未知のラベルは無視する(将来のプロファイル拡張に対して寛容な設計)。

        画像にアルファチャンネルがある場合、alpha>0の領域(Stage1で選択
        された対象領域)のみを処理対象とする。

        pattern_k: 斑紋除去(_flatten_pattern)のk-meansクラスタ数。
            指定しなければ画像の色分布から自動推定する(_auto_pattern_k)。
            固定値・自動推定値のどちらも pattern_k_min〜pattern_k_max に
            クリップする。
        """
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
        result = image.copy()
        has_alpha = result.shape[2] == 4

        bgr = result[:, :, :3]
        original_bgr = bgr.copy()
        alpha = result[:, :, 3] if has_alpha else None
        mask = self._extract_mask(alpha)
        suppress = suppress or []

        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
        v = hsv[:, :, 2].copy()

        if auto_strength:
            texture_removal_strength = self._auto_texture_strength(v, mask, texture_removal_strength)
            shadow_removal_strength = self._auto_shadow_strength(v, mask, shadow_removal_strength)
            highlight_suppression_strength = self._auto_highlight_strength(
                v, mask, highlight_suppression_strength
            )
            shadow_lift_strength = self._auto_shadow_lift_strength(v, mask, shadow_lift_strength)
            background_residue_strength = self._auto_background_residue_strength(
                v, alpha, mask, background_residue_strength
            )
            # local_contrast はceilingがそのまま強度として働く(明示的opt-inのため自動減衰しない)

        # ---- 1. 陰影補正(照明ムラの大域正規化) ----
        if any(k in suppress for k in ("shadow_soft", "shadow_hard")):
            v = self._apply_shadow_normalize(v, mask, strength=shadow_removal_strength)

        # ---- 2. ハイライト反射抑制(光沢のある外骨格・鉱物面・釉薬面など) ----
        if "specular_highlight" in suppress and highlight_suppression_strength > 0:
            v = self._apply_highlight_suppression(v, mask, strength=highlight_suppression_strength)

        # ---- 3. 深い陰影の持ち上げ(亀裂・関節部・縫合線など) ----
        # suppressリストへの明示的な指定に関わらず常時適用する(陰影は関節部を
        # 含めてすべてここで持ち上げておく方針のため)。
        if shadow_lift_strength > 0:
            v = self._apply_shadow_lift(v, mask, strength=shadow_lift_strength)

        # ---- 4. テクスチャ除去(樹皮・葉脈・苔・土砂など) ----
        if any(
            k in suppress
            for k in ("bark_texture", "leaf_veins", "lichen_moss", "soil_mud")
        ):
            v = self._remove_texture(v, mask, strength=texture_removal_strength)

        # V チャンネルをここで一旦BGRに書き戻す(以降の斑紋除去がk-meansによる
        # 色空間処理のため)。
        hsv[:, :, 2] = np.clip(v, 0, 255)
        bgr = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

        # ---- 5. 斑紋除去(減色による均一化。色情報が必要なためBGR領域で処理) ----
        if any(
            label in suppress for label in ("insect_body_pattern", "foreign_object_pattern")
        ):
            if pattern_k is not None:
                flatten_k = int(np.clip(pattern_k, pattern_k_min, pattern_k_max))
            else:
                flatten_k = self._auto_pattern_k(bgr, mask, pattern_k_min, pattern_k_max)
            bgr = self._flatten_pattern(bgr, mask, strength=texture_removal_strength, k=flatten_k)

        # 斑紋除去後、再びVチャンネルへ戻して輝度系処理を続ける
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
        v = hsv[:, :, 2].copy()

        # ---- 6. 背景残渣除去(前景境界付近の色にじみ・撮影背景の写り込み) ----
        if any(k in suppress for k in ("background_residue", "shooting_background")):
            v = self._clean_background_residue(v, alpha, mask, strength=background_residue_strength)

        # ---- 7. 局所コントラスト調整(既定OFF。明示的にceilingを設定した場合のみ) ----
        if "low_contrast" in suppress and local_contrast_strength > 0:
            v = self._apply_local_contrast(v, mask, strength=local_contrast_strength)

        hsv[:, :, 2] = np.clip(v, 0, 255)
        bgr = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

        # 対象領域外(投げ縄で除外された領域)は、HSV往復変換による量子化誤差
        # すら発生させないよう、元のBGR値をそのまま復元する。
        if mask is not None:
            bgr = self._limit_to_mask(original_bgr, bgr, mask)

        if has_alpha:
            out = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
            out[:, :, 3] = alpha
            return out
        return bgr

    # ---- 対象領域(alphaマスク)関連のヘルパー ----
    @staticmethod
    def _extract_mask(alpha: np.ndarray | None) -> np.ndarray | None:
        """アルファチャンネルがあれば、投げ縄で選択された領域(alpha>0)の
        真偽値マスクを返す。無ければNone(=画像全体を対象とする)。"""
        if alpha is None:
            return None
        return alpha > 0

    @staticmethod
    def _fill_outside_mask(channel: np.ndarray, mask: np.ndarray | None) -> np.ndarray:
        """マスク外(投げ縄で除外された領域)を、マスク内の平均値で埋める。

        除外領域の色をそのまま使うと、各処理関数の内部で行う局所平均・
        勾配計算(box-mean, Sobel等)にマスク外の値が混入してしまうため、
        マスク内の平均的な値で塗りつぶして影響を断つ。最終的な結果は
        マスク内にしか反映しないため、この塗りつぶし値自体が出力に
        残ることはない。
        """
        if mask is None:
            return channel
        out = channel.copy()
        if mask.any():
            fill_value = float(channel[mask].mean())
        else:
            fill_value = 0.0
        out[~mask] = fill_value
        return out

    @staticmethod
    def _limit_to_mask(original: np.ndarray, transformed: np.ndarray, mask: np.ndarray | None) -> np.ndarray:
        """mask外は元の値のまま残し、mask内のみtransformedを採用する。"""
        if mask is None:
            return transformed
        out = original.copy()
        out[mask] = transformed[mask]
        return out

    # ---- 自動強度算出: 画像自体の統計量に応じてceiling値をスケールする ----
    @staticmethod
    def _auto_texture_strength(
        v: np.ndarray, mask: np.ndarray | None, ceiling: float,
        reference_mean_laplacian: float = 20.0,
    ) -> float:
        """テクスチャ量(ラプラシアン絶対値の平均)を測り、
        reference_mean_laplacian を「フル強度(factor=1.0)とみなすテクスチャ量」
        として正規化し、ceilingに掛け合わせる。

        [2026-07 修正] 旧実装は「サンプル自身の70パーセンタイル値を閾値とし、
        それを超える画素の割合」をdensityとしていたが、この定義では
        percentile自体がサンプルから算出されるため、画像の実際のテクスチャ量に
        関わらずdensityが常におよそ0.3前後になり(定義上、上位30%は必ず
        その閾値を超える)、結果としてfactorがほぼ常に1.0固定になってしまう
        不具合があった(=auto_strengthが実質機能していなかった)。
        絶対量である mean(abs(Laplacian)) を使うことでこれを解消している。

        reference_mean_laplacianは実写真でのキャリブレーションが必要な値
        (要調整の目安値)。
        """
        abs_lap = np.abs(cv2.Laplacian(v.astype(np.float64), cv2.CV_64F))
        sample = abs_lap[mask] if mask is not None and mask.any() else abs_lap
        if sample.size == 0:
            return 0.0
        mean_lap = float(np.mean(sample))
        factor = min(1.0, mean_lap / reference_mean_laplacian)
        return ceiling * factor

    @staticmethod
    def _auto_shadow_strength(v: np.ndarray, mask: np.ndarray | None, ceiling: float) -> float:
        """明度チャンネルのばらつき(標準偏差)を陰影量の目安とし、
        ceilingに掛け合わせる。照明が均一な画像では過補正を避ける。
        統計量は対象領域(mask)内のみで計算する。"""
        sample = v[mask] if mask is not None and mask.any() else v
        factor = min(1.0, float(np.std(sample)) / 45.0)
        return ceiling * factor

    @staticmethod
    def _auto_highlight_strength(v: np.ndarray, mask: np.ndarray | None, ceiling: float) -> float:
        """輝度215以上の画素比率を反射量の目安とし、ceilingに掛け合わせる。
        反射スポットは通常ごく一部の面積にしか出ないため、密度の基準は低め。
        統計量は対象領域(mask)内のみで計算する。"""
        if ceiling <= 0:
            return 0.0
        sample = v[mask] if mask is not None and mask.any() else v
        density = float(np.mean(sample >= 215.0))
        factor = min(1.0, density / 0.02)
        return ceiling * factor

    @staticmethod
    def _auto_shadow_lift_strength(
        v: np.ndarray, mask: np.ndarray | None, ceiling: float,
        sh_thresh: float = 55.0, min_component_area: int = 4,
    ) -> float:
        """陰影の連結成分ごとの「深さ」(輝度がsh_threshからどれだけ低いか)を
        指標にする。

        [2026-07 修正] 旧実装は「輝度sh_thresh未満の画素が画像全体(mask内)の
        何割を占めるか」という密度ベースの指標だったが、関節部の陰影のように
        画像全体からすれば面積が小さい陰影は、密度が低く出るため強度が
        弱くなってしまい、狭くても深い陰影が十分に持ち上がらない問題があった。
        画素比率の代わりに連結成分ごとの深さを見ることで、陰影が画像全体の
        何割を占めるかに関わらず、実際に深い陰影があれば強度が上がるようにする。

        sh_thresh は photometric_filters.lift_shadows の SH_THRESH と同じ値
        (深い陰影とみなす輝度の上限)を使うこと。
        """
        if ceiling <= 0:
            return 0.0
        sample_bin = (v < sh_thresh).astype(np.uint8)
        if mask is not None:
            sample_bin[~mask] = 0
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(sample_bin, connectivity=8)
        if num_labels <= 1:
            return 0.0

        depths = []
        for label in range(1, num_labels):
            if stats[label, cv2.CC_STAT_AREA] < min_component_area:
                continue
            comp_mean = float(v[labels == label].mean())
            depths.append(sh_thresh - comp_mean)
        if not depths:
            return 0.0

        # 深いクラスタが一部でもあれば十分に効くよう、平均ではなく上位側の
        # 深さ(75パーセンタイル)を代表値とする(多数の浅い陰影に埋もれて
        # 少数の深い陰影の効果が薄まらないようにするため)。
        representative_depth = float(np.percentile(depths, 75))
        factor = min(1.0, max(0.0, representative_depth) / 30.0)
        return ceiling * factor

    @staticmethod
    def _auto_background_residue_strength(
        v: np.ndarray, alpha: np.ndarray | None, mask: np.ndarray | None, ceiling: float
    ) -> float:
        """前景境界帯(alphaのエッジ周辺)における明度のばらつきを、
        背景残渣(色にじみ・撮影背景の写り込み)量の目安とする。

        陰影補正(_auto_shadow_strength、画像全体のV分散)とは独立した
        統計量(境界帯のみのV分散)を使うことで、陰影補正の強度を変えても
        背景残渣除去の強度が連動してしまわないようにしている。
        """
        if ceiling <= 0 or alpha is None:
            return 0.0
        edge = cv2.Canny(alpha, 50, 150)
        band = cv2.dilate(edge, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        band_bool = band > 0
        if mask is not None:
            band_bool &= mask
        if not band_bool.any():
            return 0.0
        factor = min(1.0, float(np.std(v[band_bool])) / 45.0)
        return ceiling * factor

    # ---- 陰影補正: photometric_filters.shadow_normalize_full_image を strength でブレンド ----
    def _apply_shadow_normalize(self, v: np.ndarray, mask: np.ndarray | None, strength: float) -> np.ndarray:
        v_in = self._fill_outside_mask(v, mask)
        normalized = shadow_normalize_full_image(v_in)
        blended = v * (1 - strength) + normalized * strength
        return self._limit_to_mask(v, blended, mask)

    # ---- ハイライト抑制: photometric_filters.suppress_highlights_regional を strength でブレンド ----
    def _apply_highlight_suppression(self, v: np.ndarray, mask: np.ndarray | None, strength: float) -> np.ndarray:
        v_in = self._fill_outside_mask(v, mask)
        v64 = v_in.astype(np.float64)
        sobel_x = cv2.Sobel(v64, cv2.CV_64F, 1, 0, ksize=3)
        sobel_y = cv2.Sobel(v64, cv2.CV_64F, 0, 1, ksize=3)
        sobel_mag = np.hypot(sobel_x, sobel_y)
        sobel_angle = np.arctan2(sobel_y, sobel_x)
        suppressed = suppress_highlights_regional(v_in, sobel_mag, sobel_angle)
        blended = v * (1 - strength) + suppressed * strength
        return self._limit_to_mask(v, blended, mask)

    # ---- 陰影持ち上げ: photometric_filters.lift_shadows を strength でブレンド ----
    def _apply_shadow_lift(self, v: np.ndarray, mask: np.ndarray | None, strength: float) -> np.ndarray:
        v_in = self._fill_outside_mask(v, mask)
        lifted = lift_shadows(v_in)
        blended = v * (1 - strength) + lifted * strength
        return self._limit_to_mask(v, blended, mask)

    # ---- 局所コントラスト調整: photometric_filters.local_contrast_equalize を strength でブレンド ----
    def _apply_local_contrast(self, v: np.ndarray, mask: np.ndarray | None, strength: float) -> np.ndarray:
        v_in = self._fill_outside_mask(v, mask)
        equalized = local_contrast_equalize(v_in)
        blended = v * (1 - strength) + equalized * strength
        return self._limit_to_mask(v, blended, mask)

    @staticmethod
    def _bilateral_filter_masked(
        v_in: np.ndarray, mask: np.ndarray | None, sigma_s: float, sigma_r: float, iters: int,
    ) -> np.ndarray:
        """bilateral_filter_fullを、mask外接矩形(+カーネル半径分の余白)だけに
        絞って実行し、結果を元のキャンバスへ貼り戻す。対象領域外の計算を
        省略するための最適化であり、数値的な挙動は変えない(余白をカーネル
        半径ぶん確保しているため、外接矩形の境界付近でも参照する近傍画素が
        フル画像実行時と変わらない)。maskが無い場合はフル画像のまま実行する。
        """
        if mask is None or not mask.any():
            return bilateral_filter_full(v_in, sigma_s=sigma_s, sigma_r=sigma_r, iters=iters)

        h, w = v_in.shape
        ys, xs = np.where(mask)
        r = bilateral_filter_radius(sigma_s)
        y0, y1 = max(0, ys.min() - r), min(h, ys.max() + r + 1)
        x0, x1 = max(0, xs.min() - r), min(w, xs.max() + r + 1)

        filtered_crop = bilateral_filter_full(
            v_in[y0:y1, x0:x1], sigma_s=sigma_s, sigma_r=sigma_r, iters=iters
        )
        out = v_in.copy()
        out[y0:y1, x0:x1] = filtered_crop
        return out

    # ---- テクスチャ除去(樹皮・葉脈・苔など): 検出領域のみ bilateral_filter_full で平滑化 ----
    def _remove_texture(self, v: np.ndarray, mask: np.ndarray | None, strength: float) -> np.ndarray:
        v_in = self._fill_outside_mask(v, mask)
        laplacian = cv2.Laplacian(v_in.astype(np.float64), cv2.CV_64F)
        abs_lap = np.abs(laplacian)
        sample = abs_lap[mask] if mask is not None and mask.any() else abs_lap
        if sample.max() <= 0:
            return v
        threshold = np.percentile(sample, 100 - 40 * strength)
        texture_mask = (abs_lap > threshold).astype(np.uint8) * 255
        texture_mask = cv2.dilate(texture_mask, np.ones((3, 3), np.uint8))
        texture_mask_bool = texture_mask > 0
        if mask is not None:
            texture_mask_bool &= mask

        sigma_r = 40.0 + 160.0 * strength
        iters = 1 if strength < 0.5 else 2
        heavily_smoothed = self._bilateral_filter_masked(v_in, mask, sigma_s=3.0, sigma_r=sigma_r, iters=iters)

        result = v.copy()
        result[texture_mask_bool] = heavily_smoothed[texture_mask_bool]
        return result

    @staticmethod
    def _auto_pattern_k(bgr: np.ndarray, mask: np.ndarray | None,
                         k_min: int = 2, k_max: int = 8,
                         bins_per_channel: int = 8, min_bin_fraction: float = 0.01) -> int:
        """対象領域の色分布を粗いLABヒストグラムでビニングし、有意な頻度を
        持つビンの数からk-meansのクラスタ数kを見積もる。単色に近い個体は
        小さいk、複雑な配色の個体はより大きいkになる。k_min〜k_maxにクリップする。

        [2026-07 追加] 以前はkが6固定だったため、単色に近い対象では
        存在しない色境界を作って偽エッジの原因になり、複雑な斑紋の対象では
        逆に階調が潰れて必要な境界まで消える問題があった。
        """
        sample = bgr[mask] if mask is not None and mask.any() else bgr.reshape(-1, 3)
        if sample.size == 0:
            return k_min
        lab = cv2.cvtColor(sample.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2LAB).reshape(-1, 3)
        hist, _ = np.histogramdd(
            lab.astype(np.float32), bins=bins_per_channel,
            range=[(0, 255), (0, 255), (0, 255)],
        )
        total = hist.sum()
        if total <= 0:
            return k_min
        significant_bins = int(np.sum(hist >= total * min_bin_fraction))
        return int(np.clip(significant_bins, k_min, k_max))

    # ---- 斑紋除去(減色による均一化。色情報が必要なためBGRのまま処理) ----
    def _flatten_pattern(self, bgr: np.ndarray, mask: np.ndarray | None, strength: float, k: int) -> np.ndarray:
        """strength(0〜1)に応じてk-meansによる減色の強さを調整する。
        k-meansは対象領域(mask)内の画素のみを対象に行い、除外領域の色が
        クラスタ中心に混入しないようにする。mask外の画素は最終的に
        _limit_to_maskで元の値へ戻すため、ここでは計算しない。

        k は呼び出し側(process)で固定値または_auto_pattern_kによる
        自動推定値を渡すこと(対象によって適切なクラスタ数が大きく異なるため、
        ここでは既定値を持たない)。"""
        if mask is not None and mask.any():
            sample = bgr[mask].reshape((-1, 3)).astype(np.float32)
        else:
            sample = bgr.reshape((-1, 3)).astype(np.float32)

        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 15, 1.0)
        _, labels, centers = cv2.kmeans(
            sample, k, None, criteria, 4, cv2.KMEANS_PP_CENTERS
        )
        centers = np.uint8(centers)

        flattened = bgr.copy()
        if mask is not None and mask.any():
            flattened[mask] = centers[labels.flatten()]
        else:
            flattened = centers[labels.flatten()].reshape(bgr.shape)

        blend_ratio = 0.85 * strength  # strength=0なら元画像のまま
        blended = cv2.addWeighted(flattened, blend_ratio, bgr, 1 - blend_ratio, 0)
        return self._limit_to_mask(bgr, blended, mask)

    # ---- 背景残渣除去(前景境界付近の色にじみ・撮影背景の写り込み) ----
    def _clean_background_residue(
        self, v: np.ndarray, alpha: np.ndarray | None, mask: np.ndarray | None, strength: float
    ) -> np.ndarray:
        """Stage1のGrabCut/SAM境界に残りがちな縁のハレーション・背景色の
        にじみを、前景境界に沿った帯状の領域だけ bilateral_filter_full で
        平滑化して目立たなくする。アルファチャンネルが無い場合は画像全体を
        軽く平滑化するのみ。

        strengthは陰影補正(shadow_removal_strength)とは独立した
        background_residue_strengthを使う。
        """
        if alpha is None:
            return self._bilateral_filter_masked(v, mask, sigma_s=2.5, sigma_r=40.0, iters=1)

        edge = cv2.Canny(alpha, 50, 150)
        band_width = max(3, int(4 + 10 * strength))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band_width, band_width))
        band = cv2.dilate(edge, kernel)
        band_bool = band > 0
        if mask is not None:
            # 対象領域の外側(投げ縄で除外された側)は処理しない
            band_bool &= mask

        v_in = self._fill_outside_mask(v, mask)
        sigma_r = 40.0 + 100.0 * strength
        smoothed = self._bilateral_filter_masked(v_in, mask, sigma_s=3.0, sigma_r=sigma_r, iters=1)

        result = v.copy()
        result[band_bool] = smoothed[band_bool]
        return result